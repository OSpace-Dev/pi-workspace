import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Pool } from "pg";
import { applyConnectionMigration, approveModelOrigin, createModelConnection } from "./connection-store.ts";
import {
  abortTaskGrantRotation,
  applyTaskGrantMigration,
  findActiveTaskGrant,
  finishTaskGrantRotation,
  issueTaskGrant,
  revokeTaskGrants,
  rotateTaskGrant,
  TaskGrantError,
} from "./task-grant-store.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required for the isolated task grant store test");

const pool = new Pool({ connectionString: databaseUrl, max: 5 });
const key = randomBytes(32);

async function expectCode(action: () => Promise<unknown>, code: TaskGrantError["code"]): Promise<void> {
  await assert.rejects(action, (error: unknown) => error instanceof TaskGrantError && error.code === code);
}

async function connection(name: string): Promise<string> {
  const saved = await createModelConnection(pool, key, {
    displayName: name,
    baseUrl: "https://api.example.test/v1",
    modelId: "synthetic-model",
    credential: "synthetic-secret",
  }, async () => [{ address: "8.8.8.8", family: 4 }]);
  return saved.id;
}

test("stores only task-bound token digests and supports controlled rotation", async () => {
  try {
    await applyTaskGrantMigration(pool);
    await applyTaskGrantMigration(pool);
    const versions = await pool.query<{ version: number }>("SELECT version FROM schema_migrations ORDER BY version");
    assert.deepEqual(versions.rows.map((row) => row.version), [1, 2, 3]);
    await approveModelOrigin(pool, "https://api.example.test");
    const connectionId = await connection("primary");
    const otherConnectionId = await connection("other");
    const taskId = randomUUID();
    const otherTaskId = randomUUID();

    await expectCode(() => issueTaskGrant(pool, taskId, randomUUID()), "CONNECTION_UNAVAILABLE");
    const first = await issueTaskGrant(pool, taskId, connectionId);
    assert.equal(first.token.length, 43);
    assert.equal(first.taskId, taskId);
    assert.equal(first.modelConnectionId, connectionId);
    assert.equal(first.expiresAt.getTime() - first.issuedAt.getTime(), 60 * 60_000);
    assert.equal(first.expiresAt.getTime() - first.renewAt.getTime(), 10 * 60_000);
    const stored = await pool.query<{ token_hash: Buffer }>("SELECT token_hash FROM task_proxy_grants WHERE id = $1", [first.id]);
    assert.deepEqual(stored.rows[0].token_hash, createHash("sha256").update(first.token).digest());
    assert.equal(stored.rows[0].token_hash.includes(Buffer.from(first.token)), false);
    assert.equal(await findActiveTaskGrant(pool, "wrong"), null);
    assert.equal((await findActiveTaskGrant(pool, first.token))?.taskId, taskId);
    assert.notEqual((await findActiveTaskGrant(pool, first.token))?.taskId, otherTaskId);
    await expectCode(() => issueTaskGrant(pool, taskId, connectionId), "ACTIVE_GRANT_EXISTS");
    await expectCode(() => rotateTaskGrant(pool, taskId, otherConnectionId, first.id), "GRANT_NOT_ACTIVE");

    const attempts = await Promise.allSettled([
      rotateTaskGrant(pool, taskId, connectionId, first.id),
      rotateTaskGrant(pool, taskId, connectionId, first.id),
    ]);
    const successes = attempts.filter((item): item is PromiseFulfilledResult<Awaited<ReturnType<typeof rotateTaskGrant>>> => item.status === "fulfilled");
    assert.equal(successes.length, 1);
    assert.equal(attempts.filter((item) => item.status === "rejected").length, 1);
    const second = successes[0].value;
    const overlap = await pool.query<{ overlap_deadline: Date }>(
      "SELECT overlap_deadline FROM task_proxy_grants WHERE id = $1", [first.id]);
    assert.ok(overlap.rows[0].overlap_deadline.getTime() > second.issuedAt.getTime());
    assert.ok(overlap.rows[0].overlap_deadline.getTime() - second.issuedAt.getTime() <= 5 * 60_000 + 1000);
    assert.equal((await findActiveTaskGrant(pool, first.token))?.id, first.id);
    assert.equal((await findActiveTaskGrant(pool, second.token))?.id, second.id);
    await expectCode(() => rotateTaskGrant(pool, taskId, connectionId, first.id), "ROTATION_PENDING");
    await expectCode(() => finishTaskGrantRotation(pool, taskId, first.id), "GRANT_NOT_ACTIVE");

    await abortTaskGrantRotation(pool, taskId, second.id);
    assert.equal(await findActiveTaskGrant(pool, second.token), null);
    assert.equal((await findActiveTaskGrant(pool, first.token))?.id, first.id);
    const cleared = await pool.query<{ overlap_deadline: Date | null }>(
      "SELECT overlap_deadline FROM task_proxy_grants WHERE id = $1", [first.id]);
    assert.equal(cleared.rows[0].overlap_deadline, null);
    const replacement = await rotateTaskGrant(pool, taskId, connectionId, first.id);
    await pool.query("UPDATE task_proxy_grants SET overlap_deadline = clock_timestamp() - interval '1 second' WHERE id = $1", [first.id]);
    assert.equal(await findActiveTaskGrant(pool, first.token), null);
    assert.equal((await findActiveTaskGrant(pool, replacement.token))?.id, replacement.id);
    await finishTaskGrantRotation(pool, taskId, replacement.id);
    await finishTaskGrantRotation(pool, taskId, replacement.id);
    await expectCode(() => abortTaskGrantRotation(pool, taskId, replacement.id), "GRANT_NOT_ACTIVE");
    assert.equal(await findActiveTaskGrant(pool, first.token), null);
    assert.equal((await findActiveTaskGrant(pool, replacement.token))?.id, replacement.id);
    assert.equal(await revokeTaskGrants(pool, taskId), 1);
    assert.equal(await revokeTaskGrants(pool, taskId), 0);
    assert.equal(await findActiveTaskGrant(pool, replacement.token), null);

    const resumed = await issueTaskGrant(pool, taskId, otherConnectionId);
    assert.equal((await findActiveTaskGrant(pool, resumed.token))?.modelConnectionId, otherConnectionId);
    await pool.query("UPDATE model_connections SET enabled = false WHERE id = $1", [otherConnectionId]);
    assert.equal(await findActiveTaskGrant(pool, resumed.token), null);
    await expectCode(() => issueTaskGrant(pool, otherTaskId, otherConnectionId), "CONNECTION_UNAVAILABLE");

    const expiring = await issueTaskGrant(pool, otherTaskId, connectionId);
    await pool.query(`UPDATE task_proxy_grants
      SET issued_at = now() - interval '2 seconds', expires_at = now() - interval '1 second'
      WHERE id = $1`, [expiring.id]);
    assert.equal(await findActiveTaskGrant(pool, expiring.token), null);

    const pendingTaskId = randomUUID();
    const predecessor = await issueTaskGrant(pool, pendingTaskId, connectionId);
    const pending = await rotateTaskGrant(pool, pendingTaskId, connectionId, predecessor.id);
    await pool.query(`UPDATE task_proxy_grants
      SET issued_at = now() - interval '2 seconds', expires_at = now() - interval '1 second',
        overlap_deadline = now() - interval '1 second'
      WHERE id = $1`, [predecessor.id]);
    await expectCode(() => rotateTaskGrant(pool, pendingTaskId, connectionId, pending.id), "ROTATION_PENDING");
    await finishTaskGrantRotation(pool, pendingTaskId, pending.id);
    const next = await rotateTaskGrant(pool, pendingTaskId, connectionId, pending.id);
    assert.equal(next.taskId, pendingTaskId);

    const lateAbortTaskId = randomUUID();
    const lateOld = await issueTaskGrant(pool, lateAbortTaskId, connectionId);
    const lateNew = await rotateTaskGrant(pool, lateAbortTaskId, connectionId, lateOld.id);
    await pool.query("UPDATE task_proxy_grants SET overlap_deadline = clock_timestamp() - interval '1 second' WHERE id = $1", [lateOld.id]);
    await abortTaskGrantRotation(pool, lateAbortTaskId, lateNew.id);
    assert.equal(await findActiveTaskGrant(pool, lateOld.token), null);
    assert.equal(await findActiveTaskGrant(pool, lateNew.token), null);
  } finally {
    await pool.end();
  }
});

test("version 3 caps legacy lifetimes and closes pending overlap on upgrade", async () => {
  const schema = `grant_upgrade_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: databaseUrl });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const isolated = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
  try {
    await applyConnectionMigration(isolated);
    const version2 = readFileSync(new URL("../../migrations/002-task-proxy-grants.sql", import.meta.url), "utf8");
    await isolated.query(version2);
    await isolated.query("INSERT INTO schema_migrations (version, checksum) VALUES (2, $1)",
      [createHash("sha256").update(version2).digest("hex")]);
    await isolated.query("INSERT INTO approved_model_origins (origin) VALUES ('https://api.example.test')");
    const saved = await createModelConnection(isolated, key, {
      displayName: "upgrade fixture",
      baseUrl: "https://api.example.test/v1",
      modelId: "synthetic-model",
      credential: "synthetic-secret",
    }, async () => [{ address: "8.8.8.8", family: 4 }]);
    const taskId = randomUUID();
    const oldId = randomUUID();
    const nextId = randomUUID();
    const oldToken = randomBytes(32).toString("base64url");
    const nextToken = randomBytes(32).toString("base64url");
    await isolated.query(`INSERT INTO task_proxy_grants
      (id, task_id, model_connection_id, token_hash, issued_at, expires_at)
      VALUES ($1, $2, $3, $4, clock_timestamp() - interval '50 minutes', clock_timestamp() + interval '70 minutes')`,
    [oldId, taskId, saved.id, createHash("sha256").update(oldToken).digest()]);
    await isolated.query(`INSERT INTO task_proxy_grants
      (id, task_id, model_connection_id, rotated_from, token_hash, expires_at)
      VALUES ($1, $2, $3, $4, $5, clock_timestamp() + interval '1 hour')`,
    [nextId, taskId, saved.id, oldId, createHash("sha256").update(nextToken).digest()]);
    const oldBeforeUpgrade = await isolated.query<{ id: string }>(`SELECT id FROM task_proxy_grants
      WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > clock_timestamp()`,
    [createHash("sha256").update(oldToken).digest()]);
    assert.equal(oldBeforeUpgrade.rows[0].id, oldId);
    await applyTaskGrantMigration(isolated);
    await applyTaskGrantMigration(isolated);
    assert.equal(await findActiveTaskGrant(isolated, oldToken), null);
    assert.equal((await findActiveTaskGrant(isolated, nextToken))?.id, nextId);
    const capped = await isolated.query<{ issued_at: Date; expires_at: Date }>(
      "SELECT issued_at, expires_at FROM task_proxy_grants WHERE id = $1", [oldId]);
    assert.equal(capped.rows[0].expires_at.getTime() - capped.rows[0].issued_at.getTime(), 60 * 60_000);
    const versions = await isolated.query<{ version: number }>("SELECT version FROM schema_migrations ORDER BY version");
    assert.deepEqual(versions.rows.map((row) => row.version), [1, 2, 3]);
  } finally {
    await isolated.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});
