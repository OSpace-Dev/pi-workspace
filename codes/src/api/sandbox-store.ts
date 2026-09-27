import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Pool } from "pg";

export async function applySandboxMigration(pool: Pool): Promise<void> {
  const sql = readFileSync(new URL("../../migrations/007-pi-web-sandboxes.sql", import.meta.url), "utf8");
  const checksum = createHash("sha256").update(sql).digest("hex");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(73240107)");
    const applied = await client.query<{ checksum: string }>("SELECT checksum FROM schema_migrations WHERE version=7");
    if (applied.rowCount) {
      if (applied.rows[0].checksum !== checksum) throw new Error("MIGRATION_CHECKSUM_MISMATCH");
    } else {
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations(version,checksum) VALUES(7,$1)", [checksum]);
    }
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}
