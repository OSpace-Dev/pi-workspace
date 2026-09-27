import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { StringDecoder } from "node:string_decoder";

const key = process.env.PIWS_WORKER_KEY;
if (!key || key.length < 32) throw new Error("Missing worker key");

let active = null;
let pending = "";
let assistant = null;
let accepted = false;
let settled = false;
let rpcReady = false;
const decoder = new StringDecoder("utf8");
const child = spawn("pi", [
  "--mode", "rpc", "--session", "/workspace/session.jsonl", "--no-tools",
  "--no-extensions", "--no-skills", "--no-context-files",
  "--provider", "workspace", "--model", process.env.PIWS_MODEL_ID,
], { cwd: "/workspace", env: { ...process.env, PI_CODING_AGENT_DIR: "/data/pi-agent" }, stdio: ["pipe", "pipe", "pipe"] });

child.on("spawn", () => { child.stdin.write('{"id":"startup-state","type":"get_state"}\n'); });
child.on("error", () => { rpcReady = false; if (active) finish(503, { error: "PI_UNAVAILABLE" }); });
child.on("exit", () => { rpcReady = false; if (active) finish(503, { error: "PI_EXITED" }); });
child.stderr.resume();

function finish(status, body) {
  if (!active) return;
  clearTimeout(active.timer);
  active.response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  active.response.end(JSON.stringify(body));
  active = null;
  assistant = null;
  accepted = false;
  settled = false;
}

function maybeFinish() {
  if (!active || !accepted || !settled) return;
  const answer = assistant?.content?.filter((item) => item.type === "text")
    .map((item) => item.text).join("") ?? "";
  if (assistant?.stopReason !== "stop") finish(502, { error: "MODEL_FAILED" });
  else finish(200, { answer });
}

child.stdout.on("data", (chunk) => {
  pending += decoder.write(chunk);
  if (pending.length > 1024 * 1024) {
    child.kill("SIGTERM");
    return;
  }
  let newline;
  while ((newline = pending.indexOf("\n")) !== -1) {
    const line = pending.slice(0, newline).replace(/\r$/, "");
    pending = pending.slice(newline + 1);
    let record;
    try { record = JSON.parse(line); }
    catch { continue; }
    if (record.type === "response" && record.id === "startup-state") {
      rpcReady = record.success === true;
      continue;
    }
    if (!active) continue;
    if (record.type === "response" && record.id === active.id) {
      if (record.success !== true || record.data?.disposition === "handled") {
        finish(502, { error: "PROMPT_REJECTED" });
      } else { accepted = true; maybeFinish(); }
    } else if (record.type === "message_end" && record.message?.role === "assistant") {
      assistant = record.message;
    } else if (record.type === "agent_settled") {
      settled = true;
      maybeFinish();
    }
  }
});

function authorized(header) {
  const supplied = /^Bearer (.+)$/.exec(header ?? "")?.[1] ?? "";
  const left = Buffer.from(supplied);
  const right = Buffer.from(key);
  return left.length === right.length && timingSafeEqual(left, right);
}

const server = createServer(async (request, response) => {
  response.setHeader("cache-control", "no-store");
  if (!authorized(request.headers.authorization)) {
    response.writeHead(401).end();
    return;
  }
  if (request.method === "GET" && request.url === "/health") {
    response.writeHead(rpcReady ? 200 : 503, { "content-type": "application/json" });
    response.end(JSON.stringify({ ready: rpcReady, busy: active !== null }));
    return;
  }
  if (request.method !== "POST" || request.url !== "/prompt") {
    response.writeHead(404).end();
    return;
  }
  if (!rpcReady || active) {
    response.writeHead(409, { "content-type": "application/json" }).end(JSON.stringify({ error: "PI_BUSY" }));
    return;
  }
  const chunks = [];
  let size = 0;
  for await (const part of request) {
    chunks.push(part);
    size += part.length;
    if (size > 1024 * 1024) {
      response.writeHead(413).end();
      return;
    }
  }
  const input = Buffer.concat(chunks).toString("utf8");
  let message;
  try { message = JSON.parse(input).message; } catch { /* validated below */ }
  if (typeof message !== "string" || !message.trim() || Buffer.byteLength(message) > 768 * 1024) {
    response.writeHead(400).end();
    return;
  }
  const id = crypto.randomUUID();
  active = { id, response, timer: setTimeout(() => {
    finish(504, { error: "PROMPT_TIMEOUT" });
    child.kill("SIGTERM");
  }, 120_000) };
  accepted = false;
  settled = false;
  assistant = null;
  child.stdin.write(`${JSON.stringify({ id, type: "prompt", message })}\n`);
});
server.listen(4101, "0.0.0.0");
process.on("SIGTERM", () => { child.stdin.end(); server.close(); setTimeout(() => child.kill("SIGTERM"), 3000).unref(); });
