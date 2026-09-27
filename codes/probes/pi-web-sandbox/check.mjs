import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import http from "node:http";
import { Pool } from "pg";

const origin = process.env.PUBLIC_ORIGIN;
const host = new URL(origin).host;
let cookie = "";
let csrf = "";
const request = (path, method = "GET", body) => new Promise((resolve, reject) => {
  const outgoing = http.request(`http://127.0.0.1:3000/api/v1${path}`, { method,
    headers: { Host: host, Origin: origin, Cookie: cookie, "X-CSRF-Token": csrf,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, timeout: 100_000 }, (response) => {
    let text = "";
    response.on("data", (chunk) => { text += chunk; });
    response.on("end", () => {
      if (response.headers["set-cookie"]) cookie = response.headers["set-cookie"][0].split(";")[0];
      resolve({ status: response.statusCode, data: response.statusCode === 204 ? null : JSON.parse(text) });
    });
  });
  outgoing.on("error", reject);
  outgoing.on("timeout", () => outgoing.destroy(new Error("TEST_TIMEOUT")));
  outgoing.end(body === undefined ? undefined : JSON.stringify(body));
});
const login = await request("/login", "POST", { key: readFileSync(process.env.ADMIN_KEY_FILE, "utf8").trim() });
assert.equal(login.status, 200);
csrf = login.data.csrfToken;
for (const item of (await request("/sandboxes")).data.items) {
  if (item.displayName === "Pi Web 浏览器验收") {
    assert.equal((await request(`/sandboxes/${item.id}`, "DELETE")).status, 204);
  }
}
const key = readFileSync(process.env.SERVICE_KEY_FILE, "utf8").trim();
const pool = new Pool({ host: process.env.DB_HOST, database: process.env.DB_NAME,
  user: process.env.DB_USER, password: readFileSync(process.env.DB_PASSWORD_FILE, "utf8").trim() });
const runtime = (id) => fetch(`http://runtime:3002/internal/sandboxes/${id}`,
  { headers: { Authorization: `Bearer ${key}` } }).then((response) => response.json());
const fixture = await fetch("http://proxy:3001/internal/fixture", { headers: { Authorization: `Bearer ${key}` } }).then((r) => r.json());
const ids = [];
try {
  for (const name of ["Acceptance A", "Acceptance B"]) {
    const created = await request("/sandboxes", "POST", { name, connectionId: fixture.connectionId });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    ids.push(created.data.task.id);
  }
  const details = await Promise.all(ids.map((id) => request(`/sandboxes/${id}`)));
  assert.ok(details.every((item) => item.status === 200 && item.data.ready && item.data.webUrl));
  const accesses = await Promise.all(ids.map((id) => request(`/sandboxes/${id}/access`)));
  assert.ok(accesses.every((item) => item.status === 200 && item.data.password.length >= 32));
  assert.notEqual(accesses[0].data.password, accesses[1].data.password);
  assert.notEqual(accesses[0].data.url, accesses[1].data.url);
  assert.equal((await request(`/tasks/${ids[0]}`)).status, 404);
  assert.equal((await request(`/tasks/${ids[0]}/sources`)).status, 404);
  assert.equal((await request(`/sandboxes/${ids[0]}/stop`, "POST")).status, 200);
  assert.equal((await runtime(ids[0])).running, false);
  await assert.rejects(() => fetch(`${accesses[0].data.url}/`, { signal: AbortSignal.timeout(1500) }));
  assert.equal((await pool.query("SELECT status FROM model_proxy_tasks WHERE id=$1", [ids[0]])).rows[0].status, "stopped");
  assert.equal((await request(`/sandboxes/${ids[0]}/resume`, "POST")).status, 200);
  const resumed = await request(`/sandboxes/${ids[0]}/access`);
  assert.equal(resumed.status, 200);
  assert.equal(resumed.data.password, accesses[0].data.password);
  assert.match(resumed.data.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  await new Promise((resolve) => setTimeout(resolve, 35_000));
  const afterReconcile = await request(`/sandboxes/${ids[0]}`);
  console.log(JSON.stringify({ afterReconcile: afterReconcile.data }));
  assert.equal(afterReconcile.data.task.status, "idle");
  console.log(JSON.stringify({ ids, urls: accesses.map((item) => item.data.url), result: "two isolated sandboxes, lifecycle and route ownership passed" }));
} finally {
  for (const id of ids) {
    assert.equal((await request(`/sandboxes/${id}`, "DELETE")).status, 204);
    assert.equal((await runtime(id)).exists, false);
    assert.equal((await pool.query("SELECT id FROM workspace_tasks WHERE id=$1", [id])).rowCount, 0);
    assert.equal(existsSync(`${process.env.TASK_DATA_DIR}/${id}`), false);
  }
  await pool.end();
}
