import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { buildModelProxy } from "./app.ts";
import { loadMasterKey } from "./credential-vault.ts";
import { applyProxyTaskMigration } from "./proxy-task-store.ts";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

const pool = new Pool({
  host: required("DB_HOST"), user: required("DB_USER"), database: required("DB_NAME"),
  password: readFileSync(required("DB_PASSWORD_FILE"), "utf8").trim(),
  max: 5, connectionTimeoutMillis: 2000,
});
const app = buildModelProxy({
  pool, masterKey: loadMasterKey(required("MASTER_KEY_FILE")),
  serviceKey: readFileSync(required("SERVICE_KEY_FILE"), "utf8").trim(),
});
app.addHook("onClose", async () => { await pool.end(); });
await applyProxyTaskMigration(pool);
await app.listen({ host: "0.0.0.0", port: 3001 });
