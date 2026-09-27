import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";

const root = mkdtempSync(join(tmpdir(), "piws-refresh-"));
const agentDir = join(root, "agent");
const tokenFile = join(root, "token");
mkdirSync(agentDir);
writeFileSync(tokenFile, "probe-token-old\n", { mode: 0o600 });
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false } }));
writeFileSync(join(agentDir, "models.json"), JSON.stringify({
  providers: {
    probe: {
      baseUrl: "http://probe:4100/v1",
      api: "openai-completions",
      apiKey: `!cat ${tokenFile}`,
      models: [{ id: "probe-a", compat: { supportsStore: false, supportsReasoningEffort: false } }],
    },
  },
}));

const child = spawn("pi", [
  "--mode", "rpc", "--no-session", "--no-tools", "--no-extensions",
  "--no-skills", "--no-context-files", "--provider", "probe", "--model", "probe-a",
], { env: { ...process.env, PI_CODING_AGENT_DIR: agentDir } });

const records = [];
let pending = "";
let stderr = "";
let rounds = 0;
const decoder = new StringDecoder("utf8");
const timer = setTimeout(() => child.kill("SIGTERM"), 45_000);

function prompt(round) {
  child.stdin.write(`${JSON.stringify({ id: `prompt-${round}`, type: "prompt", message: `Reply briefly. Round ${round}.` })}\n`);
}

child.stdout.on("data", (bytes) => {
  pending += decoder.write(bytes);
  let newline;
  while ((newline = pending.indexOf("\n")) !== -1) {
    const line = pending.slice(0, newline).replace(/\r$/, "");
    pending = pending.slice(newline + 1);
    if (!line) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      stderr += "invalid RPC record\n";
      continue;
    }
    records.push(record);
    if (record.type === "agent_settled") {
      rounds += 1;
      if (rounds === 1) {
        const nextFile = `${tokenFile}.next`;
        writeFileSync(nextFile, "probe-token-new\n", { mode: 0o600 });
        renameSync(nextFile, tokenFile);
        prompt(2);
      } else {
        child.stdin.end();
      }
    }
  }
});
child.stderr.on("data", (bytes) => { stderr += bytes.toString("utf8"); });
prompt(1);

child.on("close", (exitCode) => {
  clearTimeout(timer);
  const assistants = records.filter((item) => item.type === "message_end" && item.message?.role === "assistant");
  const responses = records.filter((item) => item.type === "response" && /^prompt-[12]$/.test(item.id ?? ""));
  const output = JSON.stringify(records) + stderr;
  const leakedMarker = ["probe-token-old", "probe-token-new"].some((marker) => output.includes(marker));
  const summary = {
    exitCode,
    rounds,
    acceptedPrompts: responses.filter((item) => item.success === true && item.data?.disposition !== "handled").length,
    stopReasons: assistants.map((item) => item.message.stopReason),
    settled: records.filter((item) => item.type === "agent_settled").length,
    leakedMarker,
    diagnostic: stderr.replaceAll("probe-token-old", "[redacted]").replaceAll("probe-token-new", "[redacted]").slice(0, 300),
  };
  rmSync(root, { recursive: true, force: true });
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  if (exitCode !== 0 || rounds !== 2 || summary.acceptedPrompts !== 2 ||
      summary.stopReasons.join(",") !== "stop,stop" || summary.settled !== 2 || leakedMarker) {
    process.exitCode = 1;
  }
});
