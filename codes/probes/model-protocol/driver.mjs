import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";

const testCase = process.env.PROBE_CASE ?? "normal";
const agentRoot = mkdtempSync(join(tmpdir(), "piws-probe-"));
const agentDir = join(agentRoot, "agent");
mkdirSync(agentDir);
copyFileSync("/probe/agent/models.json", join(agentDir, "models.json"));
copyFileSync("/probe/agent/settings.json", join(agentDir, "settings.json"));
const child = spawn("pi", [
  "--mode", "rpc",
  "--no-session",
  "--no-tools",
  "--no-extensions",
  "--no-skills",
  "--no-context-files",
  "--provider", "probe",
  "--model", "probe-a",
], { env: { ...process.env, PI_CODING_AGENT_DIR: agentDir } });

const records = [];
let stderr = "";
let pending = "";
const decoder = new StringDecoder("utf8");
const timer = setTimeout(() => child.kill("SIGTERM"), 45_000);

child.stdout.on("data", (bytes) => {
  pending += decoder.write(bytes);
  let newline;
  while ((newline = pending.indexOf("\n")) !== -1) {
    const line = pending.slice(0, newline).replace(/\r$/, "");
    pending = pending.slice(newline + 1);
    if (!line) continue;
    try {
      const record = JSON.parse(line);
      records.push(record);
      if (record.type === "agent_settled") child.stdin.end();
    } catch {
      stderr += "invalid RPC record\n";
    }
  }
});
child.stderr.on("data", (bytes) => { stderr += bytes.toString("utf8"); });
child.stdin.write(`${JSON.stringify({ id: "probe-prompt", type: "prompt", message: `Reply briefly. CASE:${testCase}` })}\n`);

child.on("close", (exitCode) => {
  clearTimeout(timer);
  rmSync(agentRoot, { recursive: true, force: true });
  const assistant = records.filter((item) => item.type === "message_end" && item.message?.role === "assistant").at(-1)?.message;
  const promptResponse = records.find((item) => item.type === "response" && item.id === "probe-prompt");
  const assistantText = assistant?.content?.filter((block) => block.type === "text").map((block) => block.text).join("") ?? "";
  const output = JSON.stringify(records) + stderr;
  const markers = ["SYNTHETIC_UPSTREAM_SECRET", "probe-token-a", "probe-token-b", "fixture-only"];
  const summary = {
    testCase,
    exitCode,
    promptAccepted: promptResponse?.success === true && promptResponse.data?.disposition !== "handled",
    deltas: records.filter((item) => item.type === "message_update" && item.assistantMessageEvent?.type === "text_delta").length,
    settled: records.some((item) => item.type === "agent_settled"),
    stopReason: assistant?.stopReason ?? null,
    leakedMarker: markers.some((marker) => output.includes(marker)),
    diagnostic: markers.reduce((text, marker) => text.replaceAll(marker, "[redacted]"), stderr).slice(0, 300),
  };
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  const expectedStop = testCase === "normal" ? "stop" : "error";
  if (exitCode !== 0 || !summary.promptAccepted || !summary.settled || summary.stopReason !== expectedStop || summary.leakedMarker || (testCase === "normal" && (summary.deltas < 2 || assistantText !== "Synthetic answer."))) {
    process.exitCode = 1;
  }
});
