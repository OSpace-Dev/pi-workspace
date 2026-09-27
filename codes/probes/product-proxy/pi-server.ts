import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import https from "node:https";
import tls from "node:tls";
import { once } from "node:events";
import { Pool } from "pg";
import { buildModelProxy } from "../../src/model-proxy/app.ts";
import { approveModelOrigin, createModelConnection } from "../../src/model-proxy/connection-store.ts";
import { applyProxyTaskMigration, createProxyTask } from "../../src/model-proxy/proxy-task-store.ts";

const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
const key = randomBytes(32);
const certificate = readFileSync(new URL("../../src/model-proxy/fixtures/api.example.test-cert.pem", import.meta.url), "utf8");
const privateKey = readFileSync(new URL("../../src/model-proxy/fixtures/api.example.test-key.pem", import.meta.url), "utf8");
tls.setDefaultCACertificates([certificate]);
const calls = new Map<string, number>();
const upstream = https.createServer({ key: privateKey, cert: certificate }, async (request, response) => {
  if (request.headers.authorization !== "Bearer fixture-only") {
    response.writeHead(401);
    return response.end("SYNTHETIC_UPSTREAM_SECRET");
  }
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const body = JSON.parse(Buffer.concat(chunks).toString());
  const prompt = JSON.stringify(body.messages);
  const testCase = prompt.includes("CASE:reject") ? "reject" : prompt.includes("CASE:break") ? "break" : prompt.includes("CASE:nodone") ? "nodone" : "normal";
  calls.set(testCase, (calls.get(testCase) ?? 0) + 1);
  if (prompt.includes("CASE:reject")) {
    response.writeHead(429, { "content-type": "application/json" });
    return response.end('{"error":"SYNTHETIC_UPSTREAM_SECRET"}');
  }
  response.writeHead(200, { "content-type": "text/event-stream" });
  const event = (delta: unknown, finishReason: string | null = null) => `data: ${JSON.stringify({
    id: "product-fixture", object: "chat.completion.chunk", created: 1, model: "synthetic-model",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;
  response.write(event({ role: "assistant" }));
  response.write(event({ content: "Synthetic " }));
  setTimeout(() => {
    response.write(event({ content: "answer." }));
    if (prompt.includes("CASE:break")) return response.socket?.destroy();
    response.write(event({}, "stop"));
    if (testCase === "nodone") return response.end();
    response.end("data: [DONE]\n\n");
  }, 25);
});
upstream.listen(0, "127.0.0.1");
await once(upstream, "listening");
const address = upstream.address();
if (!address || typeof address === "string") throw new Error("FIXTURE_NOT_LISTENING");
await applyProxyTaskMigration(pool);
await approveModelOrigin(pool, `https://api.example.test:${address.port}`);
const connection = await createModelConnection(pool, key, {
  displayName: "Pi TLS integration fixture", baseUrl: `https://api.example.test:${address.port}/v1`,
  modelId: "synthetic-model", credential: "fixture-only",
}, async () => [{ address: "8.8.8.8", family: 4 }]);
const app = buildModelProxy({
  pool, masterKey: key, serviceKey: randomBytes(32).toString("base64url"),
  pi: {
    // Only this isolated fixture substitutes the policy result; production always uses the public-IP policy.
    resolveDestination: async (baseUrl) => ({
      baseUrl, origin: new URL(baseUrl).origin, hostname: "api.example.test", address: "127.0.0.1", family: 4,
    }),
  },
});
app.get("/fixture/task", async () => {
  const created = await createProxyTask(pool, connection.id);
  return { token: created.grant.token };
});
app.get("/fixture/counts", async () => Object.fromEntries(calls));
await app.listen({ host: "0.0.0.0", port: 4100 });
