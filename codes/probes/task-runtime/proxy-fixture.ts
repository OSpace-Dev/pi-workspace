import { readFileSync } from "node:fs";
import https from "node:https";
import tls from "node:tls";
import { once } from "node:events";
import { Pool } from "pg";
import { buildModelProxy } from "../../src/model-proxy/app.ts";
import { loadMasterKey } from "../../src/model-proxy/credential-vault.ts";
import { applyProxyTaskMigration } from "../../src/model-proxy/proxy-task-store.ts";
import { approveModelOrigin, createModelConnection } from "../../src/model-proxy/connection-store.ts";

const pool = new Pool({ host: process.env.DB_HOST, database: process.env.DB_NAME, user: process.env.DB_USER,
  password: readFileSync(process.env.DB_PASSWORD_FILE!, "utf8").trim() });
const key = loadMasterKey(process.env.MASTER_KEY_FILE!);
const serviceKey = readFileSync(process.env.SERVICE_KEY_FILE!, "utf8").trim();
const cert = readFileSync(new URL("../../src/model-proxy/fixtures/api.example.test-cert.pem", import.meta.url), "utf8");
const privateKey = readFileSync(new URL("../../src/model-proxy/fixtures/api.example.test-key.pem", import.meta.url), "utf8");
tls.setDefaultCACertificates([cert]);
let calls = 0;
const upstream = https.createServer({ cert, key: privateKey }, async (request, response) => {
  if (request.headers.authorization !== "Bearer fixture-only") return response.writeHead(401).end();
  let input = "";
  for await (const chunk of request) input += chunk.toString();
  const body = JSON.parse(input);
  calls++;
  const last = JSON.stringify(body.messages.filter((message: { role: string }) => message.role === "user").at(-1)?.content ?? "");
  if (last.includes("CASE:reject")) return response.writeHead(429).end('{"error":"SECRET_MARKER"}');
  const userCount = body.messages.filter((message: { role: string }) => message.role === "user").length;
  const answer = `Synthetic answer. User turns: ${userCount}.`;
  response.writeHead(200, { "content-type": "text/event-stream" });
  const event = (delta: unknown, finish: string | null = null) => `data: ${JSON.stringify({
    id: "fixture", object: "chat.completion.chunk", created: 1, model: "synthetic-model",
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;
  response.write(event({ role: "assistant" }));
  if (last.includes("CASE:tool") && !body.messages.some((message: { role: string }) => message.role === "tool")) {
    response.write(event({ tool_calls: [{ index: 0, id: "call_sandbox_write", type: "function",
      function: { name: "write", arguments: JSON.stringify({ path: "sandbox-tool-check.txt", content: "sandbox-only\n" }) } }] }));
    response.write(event({}, "tool_calls"));
    response.end("data: [DONE]\n\n");
    return;
  }
  response.write(event({ content: answer }));
  if (last.includes("CASE:slow")) {
    setTimeout(() => { response.write(event({}, "stop")); response.end("data: [DONE]\n\n"); }, 60_000).unref();
    return;
  }
  response.write(event({}, "stop"));
  response.end("data: [DONE]\n\n");
});
upstream.listen(0, "127.0.0.1");
await once(upstream, "listening");
const address = upstream.address();
if (!address || typeof address === "string") throw new Error("INVALID_FIXTURE");
await applyProxyTaskMigration(pool);
await pool.query("UPDATE model_connections SET enabled = false WHERE display_name = 'Synthetic runtime acceptance'");
await approveModelOrigin(pool, `https://api.example.test:${address.port}`);
const connection = await createModelConnection(pool, key, {
  displayName: "Synthetic runtime acceptance", baseUrl: `https://api.example.test:${address.port}/v1`,
  modelId: "synthetic-model", credential: "fixture-only",
}, async () => [{ address: "8.8.8.8", family: 4 }]);
const app = buildModelProxy({ pool, masterKey: key, serviceKey, pi: {
  resolveDestination: async (baseUrl) => ({
    baseUrl, origin: new URL(baseUrl).origin, hostname: "api.example.test", address: "127.0.0.1", family: 4,
  }),
} });
app.get("/internal/fixture", async () => ({ connectionId: connection.id, calls }));
await app.listen({ host: "0.0.0.0", port: 3001 });
