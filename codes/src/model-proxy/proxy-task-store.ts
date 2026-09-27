import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Pool, PoolClient } from "pg";
import { applyTaskGrantMigration, insertGrantInTransaction, type IssuedTaskGrant, type TaskGrant } from "./task-grant-store.ts";

const migration = readFileSync(new URL("../../migrations/004-model-proxy-tasks.sql", import.meta.url), "utf8");
const checksum = createHash("sha256").update(migration).digest("hex");
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const token = /^[A-Za-z0-9_-]{43}$/;

export class ProxyTaskError extends Error {
  readonly code: "INVALID_TASK" | "CONNECTION_UNAVAILABLE" | "TASK_UNAVAILABLE";
  constructor(code: ProxyTaskError["code"]) {
    super(code);
    this.name = "ProxyTaskError";
    this.code = code;
  }
}

export async function applyProxyTaskMigration(pool: Pool): Promise<void> {
  await applyTaskGrantMigration(pool);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(73240104)");
    const applied = await client.query<{ checksum: string }>("SELECT checksum FROM schema_migrations WHERE version = 4");
    if (applied.rowCount) {
      if (applied.rows[0].checksum !== checksum) throw new Error("MIGRATION_CHECKSUM_MISMATCH");
    } else {
      await client.query(migration);
      await client.query("INSERT INTO schema_migrations (version, checksum) VALUES (4, $1)", [checksum]);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function inTaskTransaction<T>(pool: Pool, taskId: string, action: (client: PoolClient) => Promise<T>): Promise<T> {
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

export async function createProxyTask(pool: Pool, connectionId: string): Promise<{ taskId: string; grant: IssuedTaskGrant }> {
  if (!uuid.test(connectionId)) throw new ProxyTaskError("INVALID_TASK");
  const taskId = randomUUID();
  return inTaskTransaction(pool, taskId, async (client) => {
    const connection = await client.query("SELECT id FROM model_connections WHERE id = $1 AND enabled = true FOR SHARE", [connectionId]);
    if (!connection.rowCount) throw new ProxyTaskError("CONNECTION_UNAVAILABLE");
    await client.query("INSERT INTO model_proxy_tasks (id, model_connection_id, status) VALUES ($1, $2, 'active')", [taskId, connectionId]);
    const grant = await insertGrantInTransaction(client, taskId, connectionId);
    return { taskId, grant };
  });
}

export async function stopProxyTask(pool: Pool, taskId: string): Promise<boolean> {
  if (!uuid.test(taskId)) throw new ProxyTaskError("INVALID_TASK");
  return inTaskTransaction(pool, taskId, async (client) => {
    const changed = await client.query(`UPDATE model_proxy_tasks SET status = 'stopped', stopped_at = clock_timestamp()
      WHERE id = $1 AND status = 'active'`, [taskId]);
    if (!changed.rowCount) return false;
    await client.query("UPDATE task_proxy_grants SET revoked_at = clock_timestamp() WHERE task_id = $1 AND revoked_at IS NULL", [taskId]);
    return true;
  });
}

export async function resumeProxyTask(pool: Pool, taskId: string): Promise<IssuedTaskGrant> {
  if (!uuid.test(taskId)) throw new ProxyTaskError("INVALID_TASK");
  return inTaskTransaction(pool, taskId, async (client) => {
    const task = await client.query<{ model_connection_id: string }>(`SELECT model_connection_id
      FROM model_proxy_tasks WHERE id = $1 AND status = 'stopped' FOR UPDATE`, [taskId]);
    if (!task.rowCount) throw new ProxyTaskError("TASK_UNAVAILABLE");
    const connectionId = task.rows[0].model_connection_id;
    const connection = await client.query("SELECT 1 FROM model_connections WHERE id = $1 AND enabled = true FOR SHARE", [connectionId]);
    if (!connection.rowCount) throw new ProxyTaskError("CONNECTION_UNAVAILABLE");
    await client.query("UPDATE model_proxy_tasks SET status = 'active', stopped_at = NULL WHERE id = $1", [taskId]);
    return insertGrantInTransaction(client, taskId, connectionId);
  });
}

export async function listProxyTaskGrantFingerprints(pool: Pool, taskId: string): Promise<{
  id: string; digest: string; rotatedFrom: string | null; rotationCompleted: boolean; renewAt: Date;
}[]> {
  if (!uuid.test(taskId)) throw new ProxyTaskError("INVALID_TASK");
  const result = await pool.query<{
    id: string; digest: string; rotated_from: string | null; rotation_completed_at: Date | null; expires_at: Date;
  }>(`SELECT id, encode(token_hash, 'hex') AS digest, rotated_from, rotation_completed_at, expires_at
    FROM task_proxy_grants WHERE task_id = $1 AND revoked_at IS NULL
      AND expires_at > clock_timestamp()
      AND (overlap_deadline IS NULL OR overlap_deadline > clock_timestamp())
      AND EXISTS (SELECT 1 FROM model_proxy_tasks t JOIN model_connections c
        ON c.id = t.model_connection_id WHERE t.id = task_id AND t.status = 'active' AND c.enabled = true)
    ORDER BY issued_at, id`, [taskId]);
  return result.rows.map((row) => ({
    id: row.id, digest: row.digest, rotatedFrom: row.rotated_from,
    rotationCompleted: row.rotation_completed_at !== null,
    renewAt: new Date(row.expires_at.getTime() - 10 * 60_000),
  }));
}

export async function findAuthorizedTaskGrant(pool: Pool, rawToken: string): Promise<TaskGrant | null> {
  if (!token.test(rawToken)) return null;
  const digest = createHash("sha256").update(rawToken).digest();
  const result = await pool.query<{
    id: string; task_id: string; model_connection_id: string; issued_at: Date; expires_at: Date;
  }>(`SELECT g.id, g.task_id, g.model_connection_id, g.issued_at, g.expires_at
    FROM task_proxy_grants g
    JOIN model_proxy_tasks t ON t.id = g.task_id AND t.model_connection_id = g.model_connection_id
    JOIN model_connections c ON c.id = g.model_connection_id
    WHERE g.token_hash = $1 AND g.revoked_at IS NULL AND g.expires_at > clock_timestamp()
      AND (g.overlap_deadline IS NULL OR g.overlap_deadline > clock_timestamp())
      AND t.status = 'active' AND c.enabled = true`, [digest]);
  const row = result.rows[0];
  return row ? {
    id: row.id, taskId: row.task_id, modelConnectionId: row.model_connection_id,
    issuedAt: row.issued_at, renewAt: new Date(row.expires_at.getTime() - 10 * 60_000), expiresAt: row.expires_at,
  } : null;
}
