import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Pool, PoolClient } from "pg";
import { applyConnectionMigration } from "./connection-store.ts";

const migrations = [
  { version: 2, source: readFileSync(new URL("../../migrations/002-task-proxy-grants.sql", import.meta.url), "utf8") },
  { version: 3, source: readFileSync(new URL("../../migrations/003-task-token-window.sql", import.meta.url), "utf8") },
];
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
const tokenLifetimeSeconds = 60 * 60;
const tokenRenewBeforeSeconds = 10 * 60;
const tokenOverlapSeconds = 5 * 60;

export type TaskGrant = {
  id: string;
  taskId: string;
  modelConnectionId: string;
  issuedAt: Date;
  renewAt: Date;
  expiresAt: Date;
};

export type IssuedTaskGrant = TaskGrant & { token: string };

type GrantRow = {
  id: string;
  task_id: string;
  model_connection_id: string;
  rotated_from: string | null;
  rotation_completed_at: Date | null;
  issued_at: Date;
  expires_at: Date;
};

export class TaskGrantError extends Error {
  readonly code: "INVALID_GRANT_INPUT" | "CONNECTION_UNAVAILABLE" | "ACTIVE_GRANT_EXISTS" |
    "GRANT_NOT_ACTIVE" | "ROTATION_PENDING";

  constructor(code: TaskGrantError["code"]) {
    super(code);
    this.name = "TaskGrantError";
    this.code = code;
  }
}

function assertUuid(value: string): void {
  if (!uuidPattern.test(value)) throw new TaskGrantError("INVALID_GRANT_INPUT");
}

function grant(row: GrantRow): TaskGrant {
  return {
    id: row.id,
    taskId: row.task_id,
    modelConnectionId: row.model_connection_id,
    issuedAt: row.issued_at,
    renewAt: new Date(row.expires_at.getTime() - tokenRenewBeforeSeconds * 1000),
    expiresAt: row.expires_at,
  };
}

async function inTaskTransaction<T>(pool: Pool, taskId: string, action: (client: PoolClient) => Promise<T>): Promise<T> {
  assertUuid(taskId);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [taskId]);
    const result = await action(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function activeGrants(client: PoolClient, taskId: string): Promise<GrantRow[]> {
  const result = await client.query<GrantRow>(`SELECT id, task_id, model_connection_id, rotated_from,
    rotation_completed_at, issued_at, expires_at
    FROM task_proxy_grants WHERE task_id = $1 AND revoked_at IS NULL AND expires_at > clock_timestamp()
      AND (overlap_deadline IS NULL OR overlap_deadline > clock_timestamp())
    ORDER BY issued_at, id FOR UPDATE`, [taskId]);
  return result.rows;
}

export async function insertGrantInTransaction(
  client: PoolClient,
  taskId: string,
  connectionId: string,
  rotatedFrom: string | null = null,
): Promise<IssuedTaskGrant> {
  const connection = await client.query("SELECT id FROM model_connections WHERE id = $1 AND enabled = true FOR SHARE", [connectionId]);
  if (!connection.rowCount) throw new TaskGrantError("CONNECTION_UNAVAILABLE");
  const token = randomBytes(32).toString("base64url");
  const digest = createHash("sha256").update(token).digest();
  const result = await client.query<GrantRow>(`INSERT INTO task_proxy_grants
    (id, task_id, model_connection_id, rotated_from, token_hash, issued_at, expires_at)
    SELECT $1, $2, $3, $4, $5, issued.at,
      issued.at + ($6::integer * interval '1 second')
    FROM (SELECT clock_timestamp() AS at) issued
    RETURNING id, task_id, model_connection_id, rotated_from,
      rotation_completed_at, issued_at, expires_at`,
  [randomUUID(), taskId, connectionId, rotatedFrom, digest, tokenLifetimeSeconds]);
  return { ...grant(result.rows[0]), token };
}

export async function applyTaskGrantMigration(pool: Pool): Promise<void> {
  await applyConnectionMigration(pool);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(73240102)");
    for (const migration of migrations) {
      const checksum = createHash("sha256").update(migration.source).digest("hex");
      const applied = await client.query<{ checksum: string }>(
        "SELECT checksum FROM schema_migrations WHERE version = $1", [migration.version]);
      if (applied.rowCount) {
        if (applied.rows[0].checksum !== checksum) throw new Error("MIGRATION_CHECKSUM_MISMATCH");
      } else {
        await client.query(migration.source);
        await client.query("INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)", [migration.version, checksum]);
      }
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function issueTaskGrant(pool: Pool, taskId: string, connectionId: string): Promise<IssuedTaskGrant> {
  assertUuid(connectionId);
  return inTaskTransaction(pool, taskId, async (client) => {
    if ((await activeGrants(client, taskId)).length) throw new TaskGrantError("ACTIVE_GRANT_EXISTS");
    return insertGrantInTransaction(client, taskId, connectionId);
  });
}

export async function rotateTaskGrant(
  pool: Pool,
  taskId: string,
  connectionId: string,
  previousGrantId: string,
): Promise<IssuedTaskGrant> {
  assertUuid(connectionId);
  assertUuid(previousGrantId);
  return inTaskTransaction(pool, taskId, async (client) => {
    const active = await activeGrants(client, taskId);
    if (!active.length || active[0].id !== previousGrantId || active[0].model_connection_id !== connectionId) {
      throw new TaskGrantError("GRANT_NOT_ACTIVE");
    }
    if (active.length !== 1 || (active[0].rotated_from && !active[0].rotation_completed_at)) {
      throw new TaskGrantError("ROTATION_PENDING");
    }
    const next = await insertGrantInTransaction(client, taskId, connectionId, previousGrantId);
    await client.query(`UPDATE task_proxy_grants
      SET overlap_deadline = LEAST(expires_at, clock_timestamp() + ($2::integer * interval '1 second'))
      WHERE id = $1`, [previousGrantId, tokenOverlapSeconds]);
    return next;
  });
}

export async function finishTaskGrantRotation(pool: Pool, taskId: string, newGrantId: string): Promise<void> {
  assertUuid(newGrantId);
  await inTaskTransaction(pool, taskId, async (client) => {
    const active = await activeGrants(client, taskId);
    const selected = active.find((item) => item.id === newGrantId);
    if (!selected?.rotated_from) throw new TaskGrantError("GRANT_NOT_ACTIVE");
    if (selected.rotation_completed_at) return;
    if (active.some((item) => item.model_connection_id !== selected.model_connection_id)) {
      throw new TaskGrantError("INVALID_GRANT_INPUT");
    }
    await client.query(`UPDATE task_proxy_grants SET revoked_at = clock_timestamp()
      WHERE task_id = $1 AND id <> $2 AND revoked_at IS NULL`, [taskId, newGrantId]);
    await client.query(`UPDATE task_proxy_grants SET rotation_completed_at = clock_timestamp()
      WHERE id = $1`, [newGrantId]);
  });
}

export async function abortTaskGrantRotation(pool: Pool, taskId: string, newGrantId: string): Promise<void> {
  assertUuid(newGrantId);
  await inTaskTransaction(pool, taskId, async (client) => {
    const active = await activeGrants(client, taskId);
    const selected = active.find((item) => item.id === newGrantId);
    if (!selected?.rotated_from || selected.rotation_completed_at || active.length > 2 ||
      active.some((item) => item.id !== newGrantId && item.id !== selected.rotated_from)) {
      throw new TaskGrantError("GRANT_NOT_ACTIVE");
    }
    await client.query("UPDATE task_proxy_grants SET revoked_at = clock_timestamp() WHERE id = $1", [newGrantId]);
    await client.query(`UPDATE task_proxy_grants SET overlap_deadline = NULL
      WHERE id = $1 AND task_id = $2 AND revoked_at IS NULL
        AND expires_at > clock_timestamp() AND overlap_deadline > clock_timestamp()`,
    [selected.rotated_from, taskId]);
  });
}

export async function revokeTaskGrants(pool: Pool, taskId: string): Promise<number> {
  return inTaskTransaction(pool, taskId, async (client) => {
    const result = await client.query(`UPDATE task_proxy_grants SET revoked_at = clock_timestamp()
      WHERE task_id = $1 AND revoked_at IS NULL`, [taskId]);
    return result.rowCount ?? 0;
  });
}

export async function findActiveTaskGrant(pool: Pool, token: string): Promise<TaskGrant | null> {
  if (!tokenPattern.test(token)) return null;
  const digest = createHash("sha256").update(token).digest();
  const result = await pool.query<GrantRow>(`SELECT g.id, g.task_id, g.model_connection_id, g.issued_at, g.expires_at
    FROM task_proxy_grants g JOIN model_connections c ON c.id = g.model_connection_id
    WHERE g.token_hash = $1 AND g.revoked_at IS NULL AND g.expires_at > clock_timestamp()
      AND (g.overlap_deadline IS NULL OR g.overlap_deadline > clock_timestamp())
      AND c.enabled = true`, [digest]);
  return result.rows[0] ? grant(result.rows[0]) : null;
}
