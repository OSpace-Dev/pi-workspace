import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Pool } from "pg";

const source = readFileSync(new URL("../../migrations/005-workspace-tasks.sql", import.meta.url), "utf8");
const checksum = createHash("sha256").update(source).digest("hex");
export const taskIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type WorkspaceTask = {
  id: string; modelConnectionId: string; connectionName: string; status: string;
  kind: "qa" | "sandbox"; displayName: string | null;
  currentGrantId: string | null; renewAt: Date | null; errorCode: string | null;
  createdAt: Date; updatedAt: Date;
};

type TaskRow = {
  id: string; model_connection_id: string; connection_name: string; status: string;
  kind: "qa" | "sandbox"; display_name: string | null;
  current_grant_id: string | null; renew_at: Date | null; error_code: string | null;
  created_at: Date; updated_at: Date;
};

function task(row: TaskRow): WorkspaceTask {
  return {
    id: row.id, modelConnectionId: row.model_connection_id, connectionName: row.connection_name,
    kind: row.kind, displayName: row.display_name,
    status: row.status, currentGrantId: row.current_grant_id, renewAt: row.renew_at,
    errorCode: row.error_code, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

const select = `SELECT t.id, t.model_connection_id, c.display_name AS connection_name,
  t.status, t.kind, t.display_name, t.current_grant_id, t.renew_at, t.error_code, t.created_at, t.updated_at
  FROM workspace_tasks t JOIN model_connections c ON c.id = t.model_connection_id`;

export async function applyWorkspaceTaskMigration(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(73240105)");
    const applied = await client.query<{ checksum: string }>("SELECT checksum FROM schema_migrations WHERE version = 5");
    if (applied.rowCount) {
      if (applied.rows[0].checksum !== checksum) throw new Error("MIGRATION_CHECKSUM_MISMATCH");
    } else {
      await client.query(source);
      await client.query("INSERT INTO schema_migrations (version, checksum) VALUES (5, $1)", [checksum]);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}

export async function insertTask(pool: Pool, id: string, connectionId: string, grantId: string, renewAt: Date,
  kind: "qa" | "sandbox" = "qa", displayName: string | null = null): Promise<void> {
  await pool.query(`INSERT INTO workspace_tasks
    (id, model_connection_id, status, current_grant_id, renew_at, kind, display_name)
    VALUES ($1, $2, 'starting', $3, $4, $5, $6)`, [id, connectionId, grantId, renewAt, kind, displayName]);
}

export async function getTask(pool: Pool, id: string): Promise<WorkspaceTask | null> {
  if (!taskIdPattern.test(id)) return null;
  const result = await pool.query<TaskRow>(`${select} WHERE t.id = $1`, [id]);
  return result.rows[0] ? task(result.rows[0]) : null;
}

export async function listTasks(pool: Pool, kind: "qa" | "sandbox" = "qa"): Promise<WorkspaceTask[]> {
  const result = await pool.query<TaskRow>(`${select} WHERE t.kind=$1 ORDER BY t.created_at DESC, t.id DESC LIMIT 100`, [kind]);
  return result.rows.map(task);
}

export async function listManagedTasks(pool: Pool): Promise<WorkspaceTask[]> {
  const result = await pool.query<TaskRow>(`${select} WHERE t.status <> 'stopped' ORDER BY t.created_at, t.id`);
  return result.rows.map(task);
}

export async function setTaskStatus(pool: Pool, id: string, from: string[], to: string,
  errorCode: string | null = null, grant?: { id: string; renewAt: Date } | null): Promise<boolean> {
  const result = await pool.query(`UPDATE workspace_tasks SET status = $3, error_code = $4,
    current_grant_id = CASE WHEN $5::boolean THEN $6::uuid ELSE current_grant_id END,
    renew_at = CASE WHEN $5::boolean THEN $7::timestamptz ELSE renew_at END,
    updated_at = clock_timestamp()
    WHERE id = $1 AND status = ANY($2::text[])`, [id, from, to, errorCode,
    grant !== undefined, grant?.id ?? null, grant?.renewAt ?? null]);
  return (result.rowCount ?? 0) > 0;
}

export async function setTaskGrant(pool: Pool, id: string, grantId: string, renewAt: Date): Promise<void> {
  await pool.query(`UPDATE workspace_tasks SET current_grant_id = $2, renew_at = $3,
    error_code = NULL, updated_at = clock_timestamp() WHERE id = $1`, [id, grantId, renewAt]);
}

export async function beginTurn(pool: Pool, id: string, question: string): Promise<number | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const changed = await client.query(`UPDATE workspace_tasks SET status = 'answering',
      updated_at = clock_timestamp(), error_code = NULL WHERE id = $1 AND status = 'idle'`, [id]);
    if (!changed.rowCount) { await client.query("ROLLBACK"); return null; }
    const result = await client.query<{ id: string }>(`INSERT INTO workspace_turns (task_id, question, status)
      VALUES ($1, $2, 'pending') RETURNING id`, [id, question]);
    await client.query("COMMIT");
    return Number(result.rows[0].id);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}

export async function finishTurn(pool: Pool, turnId: number, answer: string | null, errorCode: string | null): Promise<void> {
  await pool.query(`UPDATE workspace_turns SET answer = $2, error_code = $3,
    status = CASE WHEN $3::text IS NULL THEN 'succeeded' ELSE 'failed' END,
    completed_at = clock_timestamp(), phase = CASE WHEN $3::text IS NULL THEN 'completed' ELSE 'failed' END WHERE id = $1`, [turnId, answer, errorCode]);
}

export async function listTurns(pool: Pool, id: string): Promise<{
  id: number; question: string; answer: string | null; status: string; errorCode: string | null; createdAt: Date;
  sourceIds: string[]; result: import("./document-answer.ts").DocumentAnswer | null; phase: string;
}[]> {
  const result = await pool.query<{
    id: string; question: string; answer: string | null; status: string; error_code: string | null; created_at: Date;
    source_ids: string[]; result: import("./document-answer.ts").DocumentAnswer | null; phase: string;
  }>(`SELECT id, question, answer, status, error_code, created_at, source_ids, result, phase
    FROM workspace_turns WHERE task_id = $1 ORDER BY id`, [id]);
  return result.rows.map((row) => ({
    id: Number(row.id), question: row.question, answer: row.answer,
    status: row.status, errorCode: row.error_code, createdAt: row.created_at,
    sourceIds: row.source_ids, result: row.result, phase: row.phase,
  }));
}

export async function removeTask(pool: Pool, id: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [id]);
    const proxy = await client.query<{ status: string }>(
      "SELECT status FROM model_proxy_tasks WHERE id = $1 FOR UPDATE", [id]);
    if (proxy.rows[0]?.status !== "stopped") throw new Error("PROXY_TASK_NOT_STOPPED");
    await client.query("DELETE FROM workspace_tasks WHERE id = $1", [id]);
    await client.query("UPDATE task_proxy_grants SET rotated_from = NULL WHERE task_id = $1", [id]);
    await client.query("DELETE FROM task_proxy_grants WHERE task_id = $1", [id]);
    await client.query("DELETE FROM model_proxy_tasks WHERE id = $1 AND status = 'stopped'", [id]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}
