import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const base = process.env.TEST_ADMIN_ORIGIN ?? "http://127.0.0.1:30201";
const key = readFileSync("/secrets/admin-key", "utf8").trim();
const synthetic = "synthetic-credential-do-not-use";

async function call(path, method = "GET", body, cookie, csrf, origin = base) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...(csrf ? { "X-CSRF-Token": csrf } : {}),
      ...(method !== "GET" ? { Origin: origin } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { response, text: await response.text() };
}

assert.equal((await call("/api/v1/connections")).response.status, 401);
assert.equal((await call("/api/v1/login", "POST", { key }, undefined, undefined, "http://evil.test")).response.status, 403);
const login = await call("/api/v1/login", "POST", { key });
assert.equal(login.response.status, 200);
const cookie = login.response.headers.get("set-cookie")?.split(";")[0];
assert.ok(cookie);
assert.match(login.response.headers.get("set-cookie"), /HttpOnly; SameSite=Strict/);
const csrf = JSON.parse(login.text).csrfToken;
assert.equal((await call("/api/v1/origins", "POST", { origin: "https://example.com" }, cookie)).response.status, 403);
const approved = await call("/api/v1/origins", "POST", { origin: "https://example.com" }, cookie, csrf);
assert.equal(approved.response.status, 201);
assert.equal((await call("/api/v1/origins", "POST", { origin: "https://127.0.0.1" }, cookie, csrf)).response.status, 422);
const created = await call("/api/v1/connections", "POST", {
  displayName: "验收合成连接", baseUrl: "https://example.com/v1", modelId: "synthetic-model", credential: synthetic,
}, cookie, csrf);
if (created.response.status === 503) {
  assert.equal(JSON.parse(created.text).error.code, "DNS_UNAVAILABLE");
  assert.equal((await call("/api/v1/logout", "POST", undefined, cookie, csrf)).response.status, 200);
  assert.equal((await call("/api/v1/connections", "GET", undefined, cookie)).response.status, 401);
  console.log("Admin console API checks passed: auth, origin, CSRF, DNS fail-closed, logout; live DNS unavailable");
  process.exit(0);
}
assert.equal(created.response.status, 201, created.text);
assert.ok(!created.text.includes(synthetic));
const connection = JSON.parse(created.text);
assert.equal(connection.credentialConfigured, true);
const listed = await call("/api/v1/connections", "GET", undefined, cookie);
assert.equal(listed.response.status, 200);
assert.ok(!listed.text.includes(synthetic));
assert.ok(JSON.parse(listed.text).items.some((item) => item.id === connection.id));
const changed = await call(`/api/v1/connections/${connection.id}/credential`, "PATCH", {
  version: connection.version, credential: "synthetic-replacement",
}, cookie, csrf);
assert.equal(changed.response.status, 200, changed.text);
assert.ok(!changed.text.includes("synthetic-replacement"));
assert.equal((await call(`/api/v1/connections/${connection.id}/disable`, "PATCH", {
  version: connection.version,
}, cookie, csrf)).response.status, 409);
const disabled = await call(`/api/v1/connections/${connection.id}/disable`, "PATCH", {
  version: JSON.parse(changed.text).version,
}, cookie, csrf);
assert.equal(disabled.response.status, 200, disabled.text);
assert.equal(JSON.parse(disabled.text).enabled, false);
assert.equal((await call("/api/v1/logout", "POST", undefined, cookie, csrf)).response.status, 200);
assert.equal((await call("/api/v1/connections", "GET", undefined, cookie)).response.status, 401);
console.log("Admin console API checks passed: auth, origin, CSRF, create, replace, conflict, disable, logout");
