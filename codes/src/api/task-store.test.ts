import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Pool } from "pg";
import { applyWorkspaceTaskMigration, beginTurn, getTask, listManagedTasks, listTasks, setTaskStatus } from "./task-store.ts";
import { applyProxyTaskMigration } from "../model-proxy/proxy-task-store.ts";
import { applyDocumentMigration, DocumentStore } from "./document-store.ts";
import { parseDocuments } from "./document-input.ts";
import { approveModelOrigin, createModelConnection } from "../model-proxy/connection-store.ts";
import { InternalClient } from "./task-clients.ts";
import { TaskService } from "./task-service.ts";
import { applySandboxMigration } from "./sandbox-store.ts";

class ScriptedClient extends InternalClient {
  private readonly handler: (method: string, route: string, body?: unknown) => unknown;
  constructor(name: string, handler: (method: string, route: string, body?: unknown) => unknown) {
    super(name, "http://unused.test", "synthetic-service-key-only-00000000");
    this.handler = handler;
  }
  override async request<T>(method: string, route: string, body?: unknown): Promise<T> {
    return this.handler(method, route, body) as T;
  }
}

test("task transitions serialize concurrent questions, stops and all older managed tasks", async () => {
  if (process.env.PIWS_ACCEPTANCE_TEST !== "1") throw new Error("Run only in the isolated task acceptance database");
  const options = { host: process.env.DB_HOST, user: process.env.DB_USER, database: process.env.DB_NAME,
    password: readFileSync(process.env.DB_PASSWORD_FILE!, "utf8").trim() };
  const admin = new Pool(options);
  const schema = `task_test_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ ...options, options: `-c search_path=${schema}` });
  const ids = Array.from({ length: 102 }, () => randomUUID());
  try {
    await applyProxyTaskMigration(pool);
    await applyWorkspaceTaskMigration(pool);
    await applyDocumentMigration(pool);
    await applySandboxMigration(pool);
    await approveModelOrigin(pool, "https://api.example.test");
    const connection = await createModelConnection(pool, randomBytes(32), {
      displayName: "Isolated transition fixture", baseUrl: "https://api.example.test/v1",
      modelId: "synthetic-model", credential: "synthetic-only",
    }, async () => [{ address: "8.8.8.8", family: 4 }]);
    await pool.query(`INSERT INTO model_proxy_tasks (id, model_connection_id, status)
      SELECT id, $2, 'stopped' FROM unnest($1::uuid[]) AS id`, [ids, connection.id]);
    await pool.query(`INSERT INTO workspace_tasks (id, model_connection_id, status, created_at)
      SELECT id, $2, 'stopped', clock_timestamp() FROM unnest($1::uuid[]) AS id`, [ids, connection.id]);
    await pool.query("UPDATE workspace_tasks SET status='idle', created_at=clock_timestamp()-interval '1 day' WHERE id=$1", [ids[0]]);
    assert.equal((await listTasks(pool)).some((item) => item.id === ids[0]), false);
    assert.equal((await listManagedTasks(pool)).some((item) => item.id === ids[0]), true);
    const results = await Promise.all([beginTurn(pool, ids[0], "first"), beginTurn(pool, ids[0], "second")]);
    assert.equal(results.filter((item) => item !== null).length, 1);
    assert.equal((await getTask(pool, ids[0]))?.status, "answering");
    assert.equal(await setTaskStatus(pool, ids[0], ["idle", "answering", "failed"], "stopping"), true);
    assert.equal(await beginTurn(pool, ids[0], "late question"), null);
    assert.equal(await setTaskStatus(pool, ids[0], ["answering"], "idle"), false);
    assert.equal((await getTask(pool, ids[0]))?.status, "stopping");
    await pool.query(`UPDATE workspace_tasks SET status = CASE id
      WHEN $1::uuid THEN 'starting' WHEN $2::uuid THEN 'failed' WHEN $3::uuid THEN 'answering' ELSE status END
      WHERE id = ANY($4::uuid[])`, [ids[1], ids[2], ids[3], [ids[1], ids[2], ids[3]]]);
    await pool.query("INSERT INTO workspace_turns(task_id,question,status) VALUES($1,'interrupted','pending')", [ids[3]]);
    const calls: string[] = [];
    const nextGrantId = randomUUID();
    let fileDigest = "new-file-digest";
    let pendingRotation = true;
    const renewAt = new Date(Date.now() + 50 * 60_000).toISOString();
    const proxy = new ScriptedClient("proxy", (_method, route) => {
      calls.push(`proxy:${route}`);
      if (route.endsWith("/grants")) return { items: [{
        id: nextGrantId, digest: "new-file-digest", rotatedFrom: pendingRotation ? randomUUID() : null,
        rotationCompleted: !pendingRotation, renewAt,
      }] };
      return {};
    });
    const runtime = new ScriptedClient("runtime", (_method, route) => {
      calls.push(`runtime:${route}`);
      return { exists: true, running: true, ready: true, fingerprint: fileDigest };
    });
    const service = new TaskService(pool, proxy, runtime);
    const documents = new DocumentStore(pool);
    await pool.query("UPDATE workspace_tasks SET status='idle' WHERE id=$1", [ids[10]]);
    await documents.add(ids[10], parseDocuments([{ name: "sample.txt", base64: Buffer.from("原文🙂").toString("base64") }]));
    const questions = await Promise.allSettled([documents.beginQuestion(ids[10], "one"), documents.beginQuestion(ids[10], "two")]);
    assert.equal(questions.filter((item) => item.status === "fulfilled").length, 1);
    const old = questions.find((item) => item.status === "fulfilled");
    assert.ok(old?.status === "fulfilled");
    assert.equal(old.value.sources.length, 1);
    await assert.rejects(() => documents.add(ids[10], parseDocuments([{ name: "busy.txt", base64: "YQ==" }])));
    await service.stop(ids[10]);
    await setTaskStatus(pool, ids[10], ["stopped"], "idle");
    const next = await documents.beginQuestion(ids[10], "next");
    assert.equal(await documents.settle(ids[10], old.value.turnId, "late", null, null), false);
    assert.equal((await getTask(pool, ids[10]))?.status, "answering");
    assert.equal(await documents.settle(ids[10], next.turnId, "new", null, null), true);
    const oldResult = await pool.query("SELECT status,answer,result FROM workspace_turns WHERE id=$1", [old.value.turnId]);
    assert.equal(oldResult.rows[0].status, "failed");
    assert.equal(oldResult.rows[0].answer, null);
    assert.equal(oldResult.rows[0].result, null);
    assert.equal((await new DocumentStore(pool).list(ids[10]))[0].text, "原文🙂");
    await applyDocumentMigration(pool);
    await service.recoverInterruptedAnswers();
    assert.equal((await getTask(pool, ids[3]))?.status, "failed");
    const turn = await pool.query<{ status: string }>("SELECT status FROM workspace_turns WHERE task_id=$1", [ids[3]]);
    assert.equal(turn.rows[0].status, "failed");
    await service.reconcileAndRenew();
    assert.equal((await getTask(pool, ids[0]))?.status, "stopped");
    assert.equal((await getTask(pool, ids[1]))?.status, "failed");
    assert.ok(calls.includes(`runtime:/tasks/${ids[2]}/stop`), "failed compensation is retried");
    await pool.query("UPDATE workspace_tasks SET status='idle' WHERE id=$1", [ids[4]]);
    await service.reconcileAndRenew();
    assert.equal((await getTask(pool, ids[4]))?.currentGrantId, nextGrantId);
    assert.ok(calls.includes(`proxy:/tasks/${ids[4]}/rotation/finish`), "lost rotation confirmation reconciles using file digest");
    assert.equal(calls.some((route) => route.endsWith("/rotation/abort")), false);
    pendingRotation = false;
    fileDigest = "expired-or-unknown-digest";
    await service.reconcileAndRenew();
    assert.equal((await getTask(pool, ids[4]))?.status, "failed");
    assert.equal((await getTask(pool, ids[4]))?.errorCode, "TASK_TOKEN_UNAVAILABLE");
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});
