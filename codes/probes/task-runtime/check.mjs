import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import http from "node:http";

const publicOrigin = process.env.PUBLIC_ORIGIN;
const adminKey = readFileSync(process.env.ADMIN_KEY_FILE, "utf8").trim();
const serviceKey = readFileSync(process.env.SERVICE_KEY_FILE, "utf8").trim();
const pool = new Pool({ host: process.env.DB_HOST, database: process.env.DB_NAME, user: process.env.DB_USER,
  password: readFileSync(process.env.DB_PASSWORD_FILE, "utf8").trim() });
let cookie = "";
let csrf = "";
async function browser(path, method = "GET", body) {
  return new Promise((resolve, reject) => {
    const request = http.request(`http://127.0.0.1:3000/api/v1${path}`, {
      method, headers: { Host: new URL(publicOrigin).host, Origin: publicOrigin,
        Cookie: cookie, "X-CSRF-Token": csrf, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      timeout: 140_000,
    }, (response) => {
      let text = "";
      response.on("data", (chunk) => { text += chunk; });
      response.on("end", () => {
        if (response.headers["set-cookie"]) cookie = response.headers["set-cookie"][0].split(";")[0];
        resolve({ status: response.statusCode, data: response.statusCode === 204 ? null : JSON.parse(text) });
      });
    });
    request.on("error", reject);
    request.on("timeout", () => request.destroy(new Error("TEST_TIMEOUT")));
    request.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
async function internal(service, path, method = "GET", body) {
  const response = await fetch(`http://${service}:${service === "proxy" ? 3001 : 3002}/internal${path}`, {
    method, headers: { Authorization: `Bearer ${serviceKey}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  assert.equal(response.ok, true, `internal ${service} ${path}: ${response.status}`);
  return response.json();
}
const login = await browser("/login", "POST", { key: adminKey });
assert.equal(login.status, 200);
csrf = login.data.csrfToken;
const fixture = await internal("proxy", "/fixture");
for (const task of (await browser("/tasks")).data.items) {
  if (task.connectionName === "Synthetic runtime acceptance") {
    assert.equal((await browser(`/tasks/${task.id}`, "DELETE")).status, 204);
  }
}
const created = await browser("/tasks", "POST", { connectionId: fixture.connectionId });
assert.equal(created.status, 201, JSON.stringify(created.data));
const id = created.data.task.id;
assert.equal(created.data.task.status, "idle");
assert.equal(JSON.stringify(created.data).includes('"token"'), false);
console.log(JSON.stringify({ phase: "created", id }));
assert.equal((await browser(`/tasks/${id}/stop`, "POST")).status, 200);
assert.equal((await browser(`/tasks/${id}/resume`, "POST")).status, 200, "empty session can resume before first question");
for (let round = 1; round <= 2; round++) {
  const answer = await browser(`/tasks/${id}/prompt`, "POST", { message: `Round ${round}` });
  assert.equal(answer.status, 200, JSON.stringify(answer.data));
  assert.equal(answer.data.answer, `Synthetic answer. User turns: ${round}.`);
}
const before = await internal("runtime", `/tasks/${id}`);
assert.equal(before.running, true);
assert.equal(before.session, true);
await pool.query(`UPDATE task_proxy_grants SET issued_at = statement_timestamp() - interval '52 minutes',
  expires_at = statement_timestamp() + interval '8 minutes' WHERE task_id = $1 AND revoked_at IS NULL`, [id]);
let after;
for (let i = 0; i < 45; i++) {
  after = await internal("runtime", `/tasks/${id}`);
  if (after.fingerprint !== before.fingerprint) break;
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
assert.notEqual(after.fingerprint, before.fingerprint, "automatic rotation updated read-only directory");
const retired = await pool.query("SELECT revoked_at FROM task_proxy_grants WHERE task_id = $1 AND encode(token_hash,'hex') = $2", [id, before.fingerprint]);
assert.ok(retired.rows[0].revoked_at);
const rotatedAnswer = await browser(`/tasks/${id}/prompt`, "POST", { message: "After rotation" });
assert.equal(rotatedAnswer.status, 200, JSON.stringify(rotatedAnswer.data));
assert.equal(rotatedAnswer.data.answer, "Synthetic answer. User turns: 3.");
console.log(JSON.stringify({ phase: "two-rounds-and-rotation", oldRevoked: true }));
const stopped = await browser(`/tasks/${id}/stop`, "POST");
assert.equal(stopped.status, 200);
assert.equal(stopped.data.task.status, "stopped");
assert.equal((await internal("runtime", `/tasks/${id}`)).running, false);
assert.equal((await pool.query("SELECT count(*)::int AS count FROM task_proxy_grants WHERE task_id=$1 AND revoked_at IS NULL", [id])).rows[0].count, 0);
const resumed = await browser(`/tasks/${id}/resume`, "POST");
assert.equal(resumed.status, 200, JSON.stringify(resumed.data));
const resumeAnswer = await browser(`/tasks/${id}/prompt`, "POST", { message: "After resume" });
assert.equal(resumeAnswer.status, 200, JSON.stringify(resumeAnswer.data));
assert.equal(resumeAnswer.data.answer, "Synthetic answer. User turns: 4.");
const rejected = await browser(`/tasks/${id}/prompt`, "POST", { message: "CASE:reject" });
assert.equal(rejected.status, 502);
assert.equal(JSON.stringify(rejected.data).includes("SECRET_MARKER"), false);
const detail = await browser(`/tasks/${id}`);
assert.equal(detail.data.turns.at(-1).status, "failed");
console.log(JSON.stringify({ phase: "stop-resume-and-error", sameSession: true }));
const slow = browser(`/tasks/${id}/prompt`, "POST", { message: "CASE:slow" });
await new Promise((resolve) => setTimeout(resolve, 1000));
const interrupted = await browser(`/tasks/${id}/stop`, "POST");
assert.equal(interrupted.status, 200, JSON.stringify(interrupted.data));
assert.equal((await slow).status, 502);
assert.equal((await browser(`/tasks/${id}`)).data.task.status, "stopped");
const deletion = await browser(`/tasks/${id}`, "DELETE");
assert.equal(deletion.status, 204, JSON.stringify(deletion.data));
assert.equal((await browser(`/tasks/${id}`)).status, 404);
assert.equal((await internal("runtime", `/tasks/${id}`)).exists, false);
console.log(JSON.stringify({ phase: "cancel-delete", deleted: true }));
await pool.end();
