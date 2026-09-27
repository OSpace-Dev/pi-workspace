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
  const content = body.messages.filter((message: { role: string }) => message.role === "user").at(-1)?.content;
  const last = typeof content === "string" ? content : content.map((item: { text: string }) => item.text).join("");
  if (last.includes("CASE:reject")) return response.writeHead(429).end('{"error":"SECRET_MARKER"}');
  let answer = "Synthetic plain answer.";
  if (last.includes("QUESTION AND DOCUMENTS (JSON DATA):\n")) {
    const data = JSON.parse(last.split("QUESTION AND DOCUMENTS (JSON DATA):\n").at(-1));
    const ref = (name: string) => {
      const document = data.documents.find((item: { fileName: string }) => item.fileName === name);
      const quote = document.text.split(/\n\s*\n/).find((part: string) => part.includes("青禾")) ?? document.text;
      return { sourceId: document.sourceId, quote };
    };
    let result;
    if (data.question.includes("预算")) result = { status: "no_basis", claims: [{ text: "资料中没有预算依据。", citations: [] }] };
    else if (data.question.includes("何时")) result = { status: "conflict", claims: [{ text: "资料存在冲突：原计划为 10 月 15 日，变更资料为 10 月 20 日；没有说明哪个版本有效。", citations: [ref("delivery.md"), ref("revision.md")] }] };
    else result = { status: "answered", claims: [
      { text: "交付负责人是林晨。", citations: [ref("delivery.md")] },
      { text: "支持负责人是周宁，交付后提供 30 天支持。", citations: [ref("support.txt")] },
    ] };
    if (data.question.includes("CASE:invalid")) result.claims[0].citations = [{ sourceId: "nonexistent", quote: "不存在" }];
    if (data.question.includes("CASE:mismatch")) result.claims[0].citations[0].quote = "原文没有这段话";
    answer = data.question.includes("CASE:format") ? "not json" : JSON.stringify(result);
  }
  response.writeHead(200, { "content-type": "text/event-stream" });
  const event = (delta: unknown, finish: string | null = null) => `data: ${JSON.stringify({
    id: "fixture", object: "chat.completion.chunk", created: 1, model: "synthetic-model",
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;
  response.write(event({ role: "assistant" }));
  response.write(event({ content: answer }));
  const complete = () => { response.write(event({}, "stop")); response.end("data: [DONE]\n\n"); };
  if (last.includes("CASE:slow")) setTimeout(complete, 60_000).unref();
  else complete();
});
upstream.listen(0, "127.0.0.1");
await once(upstream, "listening");
const address = upstream.address();
if (!address || typeof address === "string") throw new Error("INVALID_FIXTURE");
await applyProxyTaskMigration(pool);
await pool.query("UPDATE model_connections SET enabled = false WHERE display_name = 'Synthetic document QA acceptance'");
await approveModelOrigin(pool, `https://api.example.test:${address.port}`);
const connection = await createModelConnection(pool, key, {
  displayName: "Synthetic document QA acceptance", baseUrl: `https://api.example.test:${address.port}/v1`,
  modelId: "synthetic-model", credential: "fixture-only",
}, async () => [{ address: "8.8.8.8", family: 4 }]);
const app = buildModelProxy({ pool, masterKey: key, serviceKey, pi: {
  resolveDestination: async (baseUrl) => ({ baseUrl, origin: new URL(baseUrl).origin,
    hostname: "api.example.test", address: "127.0.0.1", family: 4 }),
} });
app.get("/internal/fixture", async () => ({ connectionId: connection.id, calls }));
await app.listen({ host: "0.0.0.0", port: 3001 });
