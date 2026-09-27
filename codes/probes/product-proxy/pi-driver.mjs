import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";

const testCase = process.env.PROBE_CASE ?? "normal";
const seed = await fetch("http://probe:4100/fixture/task").then((response) => response.json());
const root = mkdtempSync(join(tmpdir(), "piws-product-"));
const agentDir = join(root, "agent");
mkdirSync(agentDir);
writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { probe: {
  baseUrl: "http://probe:4100/v1", api: "openai-completions", apiKey: seed.token,
  models: [{ id: "synthetic-model", maxTokens: 4096, compat: { supportsStore: false, supportsReasoningEffort: false } }],
} } }));
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
  defaultProvider: "probe", defaultModel: "synthetic-model", defaultThinkingLevel: "off",
  retry: { enabled: false, provider: { maxRetries: 0 } },
}));
const child = spawn("pi", ["--mode", "rpc", "--no-session", "--no-tools", "--no-extensions", "--no-skills", "--no-context-files", "--provider", "probe", "--model", "synthetic-model"], {
  env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
});
const records = [];
let pending = "";
let diagnostic = "";
const decoder = new StringDecoder("utf8");
const timer = setTimeout(() => child.kill("SIGTERM"), 45_000);
child.stdout.on("data", (bytes) => {
  pending += decoder.write(bytes);
  let newline;
  while ((newline = pending.indexOf("\n")) !== -1) {
    const line = pending.slice(0, newline).trim();
    pending = pending.slice(newline + 1);
    if (!line) continue;
    try {
      const record = JSON.parse(line);
      records.push(record);
      if (record.type === "agent_settled") child.stdin.end();
    } catch { diagnostic += "invalid RPC record"; }
  }
});
child.stderr.on("data", (bytes) => { diagnostic += bytes.toString(); });
child.stdin.write(`${JSON.stringify({ id: "product-prompt", type: "prompt", message: `Reply briefly. CASE:${testCase}` })}\n`);
const exitCode = await new Promise((resolve) => child.on("close", resolve));
clearTimeout(timer);
rmSync(root, { recursive: true, force: true });
const assistant = records.filter((item) => item.type === "message_end" && item.message?.role === "assistant").at(-1)?.message;
const combined = JSON.stringify(records) + diagnostic;
const summary = {
  testCase, exitCode, settled: records.some((item) => item.type === "agent_settled"),
  stopReason: assistant?.stopReason ?? null,
  deltas: records.filter((item) => item.type === "message_update" && item.assistantMessageEvent?.type === "text_delta").length,
  leakedMarker: [seed.token, "fixture-only", "SYNTHETIC_UPSTREAM_SECRET"].some((marker) => combined.includes(marker)),
};
console.log(JSON.stringify(summary));
assert.equal(exitCode, 0);
assert.equal(summary.settled, true);
assert.equal(summary.leakedMarker, false);
assert.equal(summary.stopReason, testCase === "normal" ? "stop" : "error");
const counts = await fetch("http://probe:4100/fixture/counts").then((response) => response.json());
assert.equal(counts[testCase], 1);
if (testCase === "normal") assert.equal(assistant.content.filter((item) => item.type === "text").map((item) => item.text).join(""), "Synthetic answer.");
