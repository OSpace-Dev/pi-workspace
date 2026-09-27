import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Pool } from "pg";
import { taskIdPattern } from "./task-store.ts";

export type AgentSandbox = {
  id: string; displayName: string; status: string; errorCode: string | null;
  createdAt: Date; updatedAt: Date; mode: "autonomous";
};
const select = `SELECT id, display_name AS "displayName", status, error_code AS "errorCode",
  created_at AS "createdAt", updated_at AS "updatedAt", 'autonomous' AS mode FROM agent_sandboxes`;

export async function applyAgentSandboxMigration(pool: Pool): Promise<void> {
  const sql = readFileSync(new URL("../../migrations/008-autonomous-sandboxes.sql", import.meta.url), "utf8");
  const checksum = createHash("sha256").update(sql).digest("hex");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(73240108)");
    const applied = await client.query<{ checksum: string }>("SELECT checksum FROM schema_migrations WHERE version=8");
    if (applied.rowCount) {
      if (applied.rows[0].checksum !== checksum) throw new Error("MIGRATION_CHECKSUM_MISMATCH");
    } else {
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations(version,checksum) VALUES(8,$1)", [checksum]);
    }
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}

export class AgentSandboxStore {
  private readonly pool: Pool;
  constructor(pool: Pool) { this.pool = pool; }
  async list(): Promise<AgentSandbox[]> {
    return (await this.pool.query<AgentSandbox>(`${select} ORDER BY created_at DESC,id DESC LIMIT 100`)).rows;
  }
  async managed(): Promise<AgentSandbox[]> {
    return (await this.pool.query<AgentSandbox>(`${select} WHERE status <> 'stopped' ORDER BY created_at,id`)).rows;
  }
  async get(id: string): Promise<AgentSandbox | null> {
    if (!taskIdPattern.test(id)) return null;
    return (await this.pool.query<AgentSandbox>(`${select} WHERE id=$1`, [id])).rows[0] ?? null;
  }
  async insert(id: string, name: string): Promise<void> {
    await this.pool.query("INSERT INTO agent_sandboxes(id,display_name,status) VALUES($1,$2,'starting')", [id, name]);
  }
  async transition(id: string, from: string[], to: string, error: string | null = null): Promise<boolean> {
    return Boolean((await this.pool.query(`UPDATE agent_sandboxes SET status=$3,error_code=$4,
      updated_at=clock_timestamp() WHERE id=$1 AND status=ANY($2::text[])`, [id, from, to, error])).rowCount);
  }
  async remove(id: string): Promise<void> {
    await this.pool.query("DELETE FROM agent_sandboxes WHERE id=$1 AND status='deleting'", [id]);
  }
}
