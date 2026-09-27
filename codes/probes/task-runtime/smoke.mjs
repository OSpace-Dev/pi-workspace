import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const base = process.env.TEST_ADMIN_ORIGIN ?? "http://127.0.0.1:30203";
const key = readFileSync(process.env.PIWS_ADMIN_KEY_FILE, "utf8").trim();
assert.equal((await fetch(`${base}/health`)).status, 200);
assert.equal((await fetch(`${base}/api/v1/tasks`)).status, 401);
const login = await fetch(`${base}/api/v1/login`, {
  method: "POST", headers: { Origin: base, "Content-Type": "application/json" }, body: JSON.stringify({ key }),
});
assert.equal(login.status, 200);
const cookie = login.headers.get("set-cookie").split(";")[0];
const session = await login.json();
for (const route of ["/api/v1/tasks", "/api/v1/connections", "/api/v1/origins"]) {
  const response = await fetch(`${base}${route}`, { headers: { Cookie: cookie } });
  assert.equal(response.status, 200);
  assert.ok(Array.isArray((await response.json()).items));
}
for (const route of ["/tasks", "/tasks-main.js", "/models/connections", "/models/origins"]) {
  assert.equal((await fetch(`${base}${route}`)).status, 200);
}
assert.equal((await fetch(`${base}/api/v1/logout`, {
  method: "POST", headers: { Origin: base, Cookie: cookie, "X-CSRF-Token": session.csrfToken },
})).status, 200);
console.log("product preview: health, authentication, task/model routes and logout passed");
