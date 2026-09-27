import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import http from "node:http";

const key = readFileSync(process.env.SERVICE_KEY_FILE, "utf8").trim();
async function internal(service, path, method = "GET", body) {
  const response = await fetch(`http://${service}:${service === "proxy" ? 3001 : 3002}/internal${path}`, {
    method, headers: { Authorization: `Bearer ${key}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: await response.json() };
}
function docker(method, route, body) {
  return new Promise((resolve, reject) => {
    const request = http.request({ socketPath: "/var/run/docker.sock", path: `/v1.41${route}`, method,
      headers: body === undefined ? {} : { "content-type": "application/json" } }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        if (response.statusCode >= 300) {
          reject(new Error(`docker operation ${route}: ${response.statusCode}`));
          return;
        }
        const text = Buffer.concat(chunks).toString();
        try { resolve(text ? JSON.parse(text) : null); } catch { resolve(text); }
      });
    });
    request.on("error", reject);
    request.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
async function exec(id, command) {
  const execution = await docker("POST", `/containers/piws-task-${id}/exec`, {
    AttachStdout: true, AttachStderr: true, Cmd: ["sh", "-c", command], User: "10001:10001",
  });
  await docker("POST", `/exec/${execution.Id}/start`, { Detach: false, Tty: false });
  const result = await docker("GET", `/exec/${execution.Id}/json`);
  assert.equal(result.ExitCode, 0);
}
const connectionId = (await internal("proxy", "/fixture")).data.connectionId;
const tasks = [];
const sentinel = randomUUID();
try {
  for (let i = 0; i < 2; i++) {
    const created = await internal("proxy", "/tasks", "POST", { connectionId });
    assert.equal(created.status, 201);
    tasks.push(created.data.taskId);
    const ready = await internal("runtime", `/tasks/${created.data.taskId}/prepare`, "POST", {
      modelId: "synthetic-model", token: created.data.grant.token,
    });
    assert.equal(ready.status, 200, JSON.stringify(ready.data));
  }
  const first = await docker("GET", `/containers/piws-task-${tasks[0]}/json`);
  const second = await docker("GET", `/containers/piws-task-${tasks[1]}/json`);
  assert.equal(first.HostConfig.ReadonlyRootfs, true);
  assert.deepEqual(first.HostConfig.CapDrop, ["ALL"]);
  assert.equal(first.Config.User, "10001:10001");
  assert.equal(first.Mounts.find((mount) => mount.Destination === "/run/piws-token").RW, false);
  assert.notEqual(first.Mounts.find((mount) => mount.Destination === "/workspace").Source,
    second.Mounts.find((mount) => mount.Destination === "/workspace").Source);
  assert.equal(first.Mounts.some((mount) => mount.Destination.includes("docker.sock")), false);
  await exec(tasks[0], "test ! -e /var/run/docker.sock && test ! -e /run/secrets/master_key && ! touch /run/piws-token/forbidden 2>/dev/null && printf task-one > /workspace/private-marker");
  await exec(tasks[1], "test ! -e /workspace/private-marker && test ! -e /run/secrets/master_key && ! touch /run/piws-token/forbidden 2>/dev/null");
  assert.equal((await internal("proxy", `/tasks/${tasks[0]}/stop`, "POST")).status, 200);
  assert.equal((await internal("runtime", `/tasks/${tasks[0]}/stop`, "POST")).status, 200);
  const resumed = await internal("proxy", `/tasks/${tasks[0]}/resume`, "POST");
  assert.equal(resumed.status, 200);
  assert.equal((await internal("runtime", `/tasks/${tasks[0]}/resume`, "POST", { token: resumed.data.grant.token })).status, 200);
  assert.equal((await docker("GET", `/containers/piws-task-${tasks[0]}/json`)).Id, first.Id);
  await exec(tasks[0], 'test "$(cat /workspace/private-marker)" = task-one');
  await exec(tasks[0], `node -e 'const fs=require("fs");const pids=fs.readdirSync("/proc").filter(p=>Number.isInteger(Number(p)));let worker;for(const p of pids){try{if(fs.readFileSync("/proc/"+p+"/cmdline","utf8").split(String.fromCharCode(0)).includes("/opt/piws/worker.mjs"))worker=p;}catch{}}let found=false;for(const p of pids){try{const line=fs.readFileSync("/proc/"+p+"/status","utf8").split("\\n").find(line=>line.startsWith("PPid:"));if(worker&&line&&line.slice(5).trim()===worker){process.kill(Number(p),"SIGTERM");found=true;}}catch{}}if(!found)process.exit(1)'`);
  await new Promise((resolve) => setTimeout(resolve, 250));
  const unhealthy = await internal("runtime", `/tasks/${tasks[0]}`);
  assert.equal(unhealthy.data.running, true);
  assert.equal(unhealthy.data.ready, false, "Pi exit cannot be mistaken for a ready running task");
  await docker("POST", `/containers/create?name=piws-task-${sentinel}`, {
    Image: "node:24-bookworm-slim", Cmd: ["true"], Labels: { "piws.task.id": sentinel, "piws.runtime": "impostor" },
  });
  const rejected = await internal("runtime", `/tasks/${sentinel}/delete`, "POST");
  assert.equal(rejected.status, 409);
  assert.equal(rejected.data.error.code, "CONTAINER_OWNER_MISMATCH");
  assert.ok((await docker("GET", `/containers/piws-task-${sentinel}/json`)).Id);
  console.log("non-root, read-only token, task file isolation and foreign-container deletion rejection passed");
} finally {
  for (const id of tasks) {
    await internal("proxy", `/tasks/${id}/stop`, "POST");
    const deleted = await internal("runtime", `/tasks/${id}/delete`, "POST");
    assert.equal(deleted.status, 200);
  }
  await docker("DELETE", `/containers/piws-task-${sentinel}`).catch(() => undefined);
}
