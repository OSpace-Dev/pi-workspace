import { readFileSync } from "node:fs";
import { buildManagementApi } from "./management-app.ts";
import { Pool } from "pg";
import { InternalClient } from "./task-clients.ts";
import { TaskService } from "./task-service.ts";
import { applyWorkspaceTaskMigration } from "./task-store.ts";
import { applyDocumentMigration, DocumentStore } from "./document-store.ts";
import { applySandboxMigration } from "./sandbox-store.ts";
import { applyAgentSandboxMigration, AgentSandboxStore } from "./agent-sandbox-store.ts";
import { AgentSandboxService } from "./agent-sandbox-service.ts";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

const serviceKey = readFileSync(required("SERVICE_KEY_FILE"), "utf8").trim();
const pool = process.env.DB_HOST ? new Pool({
  host: required("DB_HOST"), user: required("DB_USER"), database: required("DB_NAME"),
  password: readFileSync(required("DB_PASSWORD_FILE"), "utf8").trim(),
  max: 5, connectionTimeoutMillis: 2000,
}) : null;
if (pool) {
  await applyWorkspaceTaskMigration(pool); await applyDocumentMigration(pool); await applySandboxMigration(pool);
  await applyAgentSandboxMigration(pool);
}
const tasks = pool ? new TaskService(pool,
  new InternalClient("proxy", required("MANAGEMENT_URL"), serviceKey),
  new InternalClient("runtime", required("RUNTIME_URL"), serviceKey)) : undefined;
const agents = pool && tasks ? new AgentSandboxService(new AgentSandboxStore(pool),
  new InternalClient("runtime", required("RUNTIME_URL"), serviceKey), tasks) : undefined;
const app = buildManagementApi({
  adminKey: readFileSync(required("ADMIN_KEY_FILE"), "utf8").trim(),
  serviceKey,
  publicOrigin: required("PUBLIC_ORIGIN"),
  managementUrl: required("MANAGEMENT_URL"),
  tasks,
  agents,
  documents: pool ? new DocumentStore(pool) : undefined,
});
if (tasks) {
  await tasks.recoverInterruptedAnswers();
  await tasks.reconcileAndRenew();
  await agents?.reconcile();
  let checking = false;
  const timer = setInterval(async () => {
    if (checking) return;
    checking = true;
    try { await tasks.reconcileAndRenew(); await agents?.reconcile(); }
    catch { console.warn("TASK_RECONCILIATION_RETRY"); }
    finally { checking = false; }
  }, 30_000);
  app.addHook("onClose", async () => { clearInterval(timer); await pool?.end(); });
}
await app.listen({ host: "0.0.0.0", port: 3000 });
