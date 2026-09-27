import { createServer } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setTimeout as delay } from "node:timers/promises";

const tasks = new Map([
  ["probe-token-a", "probe-a"],
  ["probe-token-b", "probe-b"],
]);
const sensitiveMarker = "SYNTHETIC_UPSTREAM_SECRET";
const allowedRequestKeys = new Set(["model", "messages", "stream", "stream_options", "max_completion_tokens"]);

function reject(response, status, code) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: { code, message: code } }));
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new Error("REQUEST_TOO_LARGE");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

const upstream = createServer(async (request, response) => {
  if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
    return reject(response, 404, "NOT_FOUND");
  }
  if (request.headers.authorization !== "Bearer fixture-only") {
    return reject(response, 401, "UPSTREAM_UNAUTHORIZED");
  }
  const body = await readJson(request);
  const prompt = JSON.stringify(body.messages);
  const testCase = prompt.includes("CASE:reject") ? "reject" : prompt.includes("CASE:break") ? "break" : "normal";
  process.stdout.write(`${JSON.stringify({ type: "upstream", testCase })}\n`);
  if (testCase === "reject") {
    response.writeHead(429, { "content-type": "application/json" });
    return response.end(JSON.stringify({ error: sensitiveMarker }));
  }
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const chunk = (delta, finishReason = null) => ({
    id: "probe-completion",
    object: "chat.completion.chunk",
    created: 1,
    model: body.model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  });
  response.write(`data: ${JSON.stringify(chunk({ role: "assistant" }))}\n\n`);
  await delay(25);
  response.write(`data: ${JSON.stringify(chunk({ content: "Synthetic " }))}\n\n`);
  await delay(25);
  response.write(`data: ${JSON.stringify(chunk({ content: "answer." }))}\n\n`);
  if (testCase === "break") {
    return response.socket?.destroy();
  }
  response.write(`data: ${JSON.stringify(chunk({}, "stop"))}\n\n`);
  response.end("data: [DONE]\n\n");
});

const proxy = createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    response.writeHead(200);
    return response.end("ok");
  }
  if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
    return reject(response, 404, "NOT_FOUND");
  }
  const token = /^Bearer (.+)$/.exec(request.headers.authorization ?? "")?.[1];
  const allowedModel = tasks.get(token);
  if (!allowedModel) return reject(response, 401, "UNAUTHORIZED");

  let body;
  try {
    body = await readJson(request);
  } catch (error) {
    return reject(response, error.message === "REQUEST_TOO_LARGE" ? 413 : 400, "INVALID_REQUEST");
  }
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    body?.model !== allowedModel ||
    body.stream !== true ||
    !Array.isArray(body.messages) ||
    body.messages.length === 0 ||
    Object.keys(body).some((key) => !allowedRequestKeys.has(key))
  ) {
    return reject(response, 403, "REQUEST_NOT_ALLOWED");
  }
  process.stdout.write(`${JSON.stringify({ type: "request", model: body.model, keys: Object.keys(body).sort() })}\n`);

  const controller = new AbortController();
  response.on("close", () => {
    if (!response.writableEnded) controller.abort();
  });
  try {
    const result = await fetch("http://127.0.0.1:4101/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer fixture-only" },
      body: JSON.stringify(body),
      signal: controller.signal,
      redirect: "error",
    });
    if (!result.ok || !result.body || !result.headers.get("content-type")?.startsWith("text/event-stream")) {
      await result.body?.cancel();
      return reject(response, 502, "UPSTREAM_FAILED");
    }
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    await pipeline(Readable.fromWeb(result.body), response);
  } catch {
    if (response.headersSent) response.destroy();
    else reject(response, 502, "UPSTREAM_FAILED");
  }
});

upstream.listen(4101, "127.0.0.1", () => {
  proxy.listen(4100, "0.0.0.0");
});
