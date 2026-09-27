import { readFileSync } from "node:fs";
import { buildRuntimeAgent } from "./app.ts";
import { DockerEngine } from "./docker-engine.ts";
import { TaskFiles } from "./task-files.ts";
import { TaskRuntime } from "./task-runtime.ts";
import { SandboxRuntime } from "./sandbox-runtime.ts";
import { AgentSandboxRuntime } from "./agent-sandbox-runtime.ts";
import { AgentSandboxFiles } from "./agent-sandbox-files.ts";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

const files = new TaskFiles(required("TASK_DATA_DIR"), required("TASK_DATA_HOST_DIR"));
const docker = new DockerEngine();
const runtime = new TaskRuntime(docker, files, required("TASK_IMAGE"), required("TASK_NETWORK"));
const sandbox = process.env.SANDBOX_IMAGE ? new SandboxRuntime(docker, files,
  required("SANDBOX_IMAGE"), required("SANDBOX_GATEWAY_IMAGE"),
  required("TASK_NETWORK"), required("MANAGEMENT_NETWORK")) : undefined;
const serviceKey = readFileSync(required("SERVICE_KEY_FILE"), "utf8").trim();
const agents = sandbox ? new AgentSandboxRuntime(docker,
  new AgentSandboxFiles(required("TASK_DATA_DIR"), required("TASK_DATA_HOST_DIR"), required("SANDBOX_SCOPE")),
  required("SANDBOX_IMAGE"), required("SANDBOX_GATEWAY_IMAGE"), required("MANAGEMENT_NETWORK")) : undefined;
await buildRuntimeAgent(runtime, serviceKey, sandbox, agents).listen({ host: "0.0.0.0", port: 3002 });
