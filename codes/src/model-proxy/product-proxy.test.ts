import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { PassThrough } from "node:stream";
import test from "node:test";
import Fastify from "fastify";
import { Pool } from "pg";
import { ActiveStreams } from "./active-streams.ts";
import { approveModelOrigin, createModelConnection } from "./connection-store.ts";
import { registerPiRoutes } from "./pi-routes.ts";
import { applyProxyTaskMigration, createProxyTask, findAuthorizedTaskGrant, stopProxyTask } from "./proxy-task-store.ts";
import { registerTaskRoutes } from "./task-routes.ts";
import { registerManagementRoutes } from "./management-routes.ts";
import { UpstreamTransportError } from "./https-transport.ts";
import type { AllowedDestination } from "./upstream-policy.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");
const pool = new Pool({ connectionString: databaseUrl, max: 5 });
const key = randomBytes(32);
const serviceKey = randomBytes(32).toString("base64url");
const upstreamSecret = "SYNTHETIC_UPSTREAM_SECRET";
const body = { model: "synthetic-model", messages: [{ role: "user", content: "hello" }], stream: true,
  stream_options: { include_usage: true }, max_completion_tokens: 128 };

test("authorized Pi stream, request boundaries, and stop cancellation", async () => {
  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024 });
  const streams = new ActiveStreams();
  let upstreamCalls = 0;
  let holdStream = false;
  let failUpstream = false;
  let observedCredential = "";
  let observedDestination: AllowedDestination | undefined;
  let resolutionStarted: (() => void) | undefined;
  let resolutionResume: Promise<void> | undefined;
  try {
    await applyProxyTaskMigration(pool);
    await applyProxyTaskMigration(pool);
    await approveModelOrigin(pool, "https://api.example.test");
    const connection = await createModelConnection(pool, key, {
      displayName: "product proxy fixture", baseUrl: "https://api.example.test/v1",
      modelId: "synthetic-model", credential: upstreamSecret,
    }, async () => [{ address: "8.8.8.8", family: 4 }]);

    app.addHook("onRequest", async (request, reply) => {
      if (request.url.startsWith("/internal/") && request.headers.authorization !== `Bearer ${serviceKey}`) {
        return reply.code(401).send({ error: { code: "UNAUTHORIZED" } });
      }
    });
    registerTaskRoutes(app, pool, streams);
    registerManagementRoutes(app, pool, key, streams);
    registerPiRoutes(app, pool, key, streams, {
      resolveDestination: async (baseUrl, origins) => {
        resolutionStarted?.();
        if (resolutionResume) await resolutionResume;
        assert.equal(baseUrl, "https://api.example.test/v1");
        assert.deepEqual([...origins], ["https://api.example.test"]);
        return { baseUrl, origin: "https://api.example.test", hostname: "api.example.test", address: "8.8.8.8", family: 4 };
      },
      postStream: async (destination, upstreamBody, options) => {
        upstreamCalls++;
        observedCredential = options.credential ?? "";
        observedDestination = destination;
        assert.deepEqual(JSON.parse(Buffer.from(upstreamBody).toString()), body);
        if (failUpstream) throw new UpstreamTransportError("UPSTREAM_STATUS");
        const stream = new PassThrough();
        if (holdStream) {
          stream.write("data: partial\n\n");
          options.signal?.addEventListener("abort", () => stream.destroy(new Error("cancelled")), { once: true });
        } else {
          stream.end("data: {\"choices\":[]}\n\ndata: [DONE]\n\n");
        }
        return stream;
      },
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`;
    const create = await fetch(`${base}/internal/tasks`, {
      method: "POST", headers: { authorization: `Bearer ${serviceKey}`, "content-type": "application/json" },
      body: JSON.stringify({ connectionId: connection.id }),
    });
    assert.equal(create.status, 201);
    const created = await create.json() as { taskId: string; grant: { token: string } };
    const call = (token: string, requestBody: unknown = body) => fetch(`${base}/v1/chat/completions`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(requestBody),
    });
    assert.equal((await call("invalid")).status, 401);
    assert.equal((await call(created.grant.token, { ...body, tools: [] })).status, 400);
    assert.equal((await call(created.grant.token, { ...body, model: "other" })).status, 403);
    assert.equal(upstreamCalls, 0);
    failUpstream = true;
    const failed = await call(created.grant.token);
    assert.equal(failed.status, 502);
    assert.ok(!(await failed.text()).includes(upstreamSecret));
    failUpstream = false;
    const answer = await call(created.grant.token);
    assert.equal(answer.status, 200);
    assert.match(await answer.text(), /data: \[DONE\]/);
    assert.equal(observedCredential, upstreamSecret);
    assert.equal(observedDestination?.address, "8.8.8.8");
    holdStream = true;
    const active = await call(created.grant.token);
    assert.equal(active.status, 200);
    const reader = active.body!.getReader();
    await reader.read();
    assert.equal((await call(created.grant.token)).status, 429);
    const stop = await fetch(`${base}/internal/tasks/${created.taskId}/stop`, {
      method: "POST", headers: { authorization: `Bearer ${serviceKey}` },
    });
    assert.equal(stop.status, 200);
    await assert.rejects(() => reader.read());
    assert.equal((await call(created.grant.token)).status, 401);
    assert.equal(await findAuthorizedTaskGrant(pool, created.grant.token), null);
    assert.equal(await stopProxyTask(pool, created.taskId), false);
    assert.equal(upstreamCalls, 3);
    const delayed = await createProxyTask(pool, connection.id);
    let releaseResolution!: () => void;
    resolutionResume = new Promise<void>((resolve) => { releaseResolution = resolve; });
    const resolutionObserved = new Promise<void>((resolve) => { resolutionStarted = resolve; });
    const pending = call(delayed.grant.token);
    await resolutionObserved;
    const stoppedWhileResolving = await fetch(`${base}/internal/tasks/${delayed.taskId}/stop`, {
      method: "POST", headers: { authorization: `Bearer ${serviceKey}` },
    });
    assert.equal(stoppedWhileResolving.status, 200);
    releaseResolution();
    assert.equal((await pending).status, 401);
    assert.equal(upstreamCalls, 3);
    resolutionStarted = undefined;
    resolutionResume = undefined;
    const expired = await createProxyTask(pool, connection.id);
    await pool.query(`UPDATE task_proxy_grants SET issued_at = now() - interval '2 seconds', expires_at = now() - interval '1 second'
      WHERE id = $1`, [expired.grant.id]);
    assert.equal((await call(expired.grant.token)).status, 401);
    const disabled = await createProxyTask(pool, connection.id);
    const connectionStream = await call(disabled.grant.token);
    const connectionReader = connectionStream.body!.getReader();
    await connectionReader.read();
    const disableResult = await fetch(`${base}/internal/connections/${connection.id}/disable`, {
      method: "PATCH", headers: { authorization: `Bearer ${serviceKey}`, "content-type": "application/json" },
      body: JSON.stringify({ version: connection.version }),
    });
    assert.equal(disableResult.status, 200);
    await assert.rejects(() => connectionReader.read());
    assert.equal((await call(disabled.grant.token)).status, 401);
    assert.equal((await fetch(`${base}/internal/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ connectionId: connection.id }) })).status, 401);
  } finally {
    streams.abortAll();
    await app.close();
    await pool.end();
  }
});

test("task creation rejects unavailable connection", async () => {
  const isolated = new Pool({ connectionString: databaseUrl });
  try {
    await assert.rejects(() => createProxyTask(isolated, randomUUID()));
  } finally {
    await isolated.end();
  }
});
