import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Pool } from "pg";
import { DocumentError, documentLimits, type DocumentInput } from "./document-input.ts";
import { taskIdPattern } from "./task-store.ts";
import type { DocumentAnswer } from "./document-answer.ts";

export type DocumentSource = {
  id: string; name: string; text: string; byteCount: number; sha256: string; createdAt: Date;
};
type SourceRow = { id: string; file_name: string; text_content: string; byte_count: number; sha256: string; created_at: Date };
function source(row: SourceRow): DocumentSource {
  return { id: row.id, name: row.file_name, text: row.text_content, byteCount: row.byte_count,
    sha256: row.sha256, createdAt: row.created_at };
}
const columns = "id, file_name, text_content, byte_count, sha256, created_at";

export async function applyDocumentMigration(pool: Pool): Promise<void> {
  const sql = readFileSync(new URL("../../migrations/006-task-documents.sql", import.meta.url), "utf8");
  const checksum = createHash("sha256").update(sql).digest("hex");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(73240106)");
    const previous = await client.query("SELECT checksum FROM schema_migrations WHERE version = 6");
    if (previous.rowCount) {
      if (previous.rows[0].checksum !== checksum) throw new Error("MIGRATION_CHECKSUM_MISMATCH");
    } else {
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations(version, checksum) VALUES(6,$1)", [checksum]);
    }
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}

export class DocumentStore {
  private readonly pool: Pool;
  constructor(pool: Pool) { this.pool = pool; }

  private async requireTask(id: string): Promise<void> {
    if (!taskIdPattern.test(id) || !(await this.pool.query("SELECT id FROM workspace_tasks WHERE id=$1 AND kind='qa'", [id])).rowCount) {
      throw new DocumentError("TASK_NOT_FOUND", 404);
    }
  }

  async list(id: string): Promise<DocumentSource[]> {
    await this.requireTask(id);
    return (await this.pool.query<SourceRow>(`SELECT ${columns} FROM workspace_sources WHERE task_id=$1 ORDER BY created_at,id`, [id])).rows.map(source);
  }

  async get(id: string, sourceId: string): Promise<DocumentSource> {
    await this.requireTask(id);
    if (!taskIdPattern.test(sourceId)) throw new DocumentError("SOURCE_NOT_FOUND", 404);
    const result = await this.pool.query<SourceRow>(`SELECT ${columns} FROM workspace_sources WHERE task_id=$1 AND id=$2`, [id, sourceId]);
    if (!result.rows[0]) throw new DocumentError("SOURCE_NOT_FOUND", 404);
    return source(result.rows[0]);
  }

  async add(id: string, files: DocumentInput[]): Promise<DocumentSource[]> {
    if (!taskIdPattern.test(id)) throw new DocumentError("TASK_NOT_FOUND", 404);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const task = await client.query("SELECT status FROM workspace_tasks WHERE id=$1 AND kind='qa' FOR UPDATE", [id]);
      if (!task.rows[0]) throw new DocumentError("TASK_NOT_FOUND", 404);
      if (!["idle", "stopped"].includes(task.rows[0].status)) throw new DocumentError("TASK_NOT_IDLE", 409);
      const existing = await client.query<{ file_name: string; byte_count: number }>("SELECT file_name,byte_count FROM workspace_sources WHERE task_id=$1", [id]);
      if (existing.rows.length + files.length > documentLimits.count) throw new DocumentError("DOCUMENT_TOO_MANY", 413);
      if (existing.rows.reduce((sum, row) => sum + row.byte_count, 0) + files.reduce((sum, file) => sum + file.bytes.length, 0) > documentLimits.totalBytes) {
        throw new DocumentError("DOCUMENT_TOTAL_TOO_LARGE", 413);
      }
      if (files.some((file) => existing.rows.some((row) => row.file_name === file.name))) throw new DocumentError("DOCUMENT_DUPLICATE_NAME", 409);
      const added: DocumentSource[] = [];
      for (const file of files) {
        const result = await client.query<SourceRow>(`INSERT INTO workspace_sources
          (id,task_id,file_name,original_bytes,text_content,byte_count,sha256) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING ${columns}`,
          [file.id,id,file.name,file.bytes,file.text,file.bytes.length,file.sha256]);
        added.push(source(result.rows[0]));
      }
      await client.query("COMMIT");
      return added;
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }

  async beginQuestion(id: string, question: string): Promise<{ turnId: number; sources: DocumentSource[] }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const task = await client.query("SELECT status FROM workspace_tasks WHERE id=$1 AND kind='qa' FOR UPDATE", [id]);
      if (!task.rows[0]) throw new DocumentError("TASK_NOT_FOUND", 404);
      if (task.rows[0].status !== "idle") throw new DocumentError("TASK_NOT_IDLE", 409);
      const sources = (await client.query<SourceRow>(`SELECT ${columns} FROM workspace_sources WHERE task_id=$1 ORDER BY created_at,id`, [id])).rows.map(source);
      await client.query("UPDATE workspace_tasks SET status='answering',error_code=NULL,updated_at=clock_timestamp() WHERE id=$1", [id]);
      const turn = await client.query(`INSERT INTO workspace_turns(task_id,question,status,source_ids,phase)
        VALUES($1,$2,'pending',$3,'preparing') RETURNING id`, [id,question,sources.map((item) => item.id)]);
      await client.query("COMMIT");
      return { turnId: Number(turn.rows[0].id), sources };
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }

  async phase(turnId: number, phase: string): Promise<void> {
    await this.pool.query("UPDATE workspace_turns SET phase=$2 WHERE id=$1 AND status='pending'", [turnId,phase]);
  }

  async settle(id: string, turnId: number, answer: string | null, result: DocumentAnswer | null, errorCode: string | null): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const task = await client.query("SELECT status FROM workspace_tasks WHERE id=$1 FOR UPDATE", [id]);
      const error = task.rows[0]?.status === "answering" ? errorCode : (errorCode ?? "ANSWER_INTERRUPTED");
      const changed = await client.query(`UPDATE workspace_turns SET answer=$3,result=$4,error_code=$5,
        status=CASE WHEN $5::text IS NULL THEN 'succeeded' ELSE 'failed' END,
        phase=CASE WHEN $5::text IS NULL THEN 'completed' ELSE 'failed' END,completed_at=clock_timestamp()
        WHERE task_id=$1 AND id=$2 AND status='pending'`, [id,turnId,error ? null : answer,error ? null : JSON.stringify(result),error]);
      if (changed.rowCount && task.rows[0]?.status === "answering") {
        await client.query("UPDATE workspace_tasks SET status='idle',error_code=$2,updated_at=clock_timestamp() WHERE id=$1", [id,error]);
      }
      await client.query("COMMIT");
      return Boolean(changed.rowCount) && error === null;
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }
}
