import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const base = process.env.TEST_ADMIN_ORIGIN ?? "http://127.0.0.1:30206";
const login = await fetch(`${base}/api/v1/login`, { method: "POST", headers: { Origin: base, "Content-Type": "application/json" },
  body: JSON.stringify({ key: readFileSync(process.env.PIWS_ADMIN_KEY_FILE, "utf8").trim() }) });
assert.equal(login.status, 200);
const cookie = login.headers.get("set-cookie").split(";")[0];
const csrf = (await login.json()).csrfToken;
async function api(path, method = "GET", body) {
  const response = await fetch(`${base}/api/v1${path}`, { method, headers: { Origin: base, Cookie: cookie, "X-CSRF-Token": csrf,
    ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = response.status === 204 ? null : await response.json();
  assert.equal(response.ok, true, JSON.stringify(data));
  return data;
}
let id = process.env.PIWS_SHOWCASE_TASK;
if (process.argv.includes("--delete-created-task")) {
  assert.match(id, /^[0-9a-f-]{36}$/);
  assert.equal((await api(`/tasks/${id}`)).task.connectionName, "Synthetic document QA acceptance");
  await api(`/tasks/${id}`, "DELETE");
  console.log("Removed specified synthetic task created during this increment.");
  process.exit(0);
}
if (!id) {
  const connections = await api("/connections");
  const connection = connections.items.find((item) => item.enabled && item.displayName === "Synthetic document QA acceptance");
  assert.ok(connection);
  id = (await api("/tasks", "POST", { connectionId: connection.id })).task.id;
  const file = (name) => ({ name, base64: readFileSync(new URL(`samples/${name}`, import.meta.url)).toString("base64") });
  await api(`/tasks/${id}/sources`, "POST", { files: [file("delivery.md"),file("support.txt")] });
  await api(`/tasks/${id}/prompt`, "POST", { message: "谁负责交付和支持，支持多久？" });
  await api(`/tasks/${id}/prompt`, "POST", { message: "预算是多少？" });
  await api(`/tasks/${id}/sources`, "POST", { files: [file("revision.md")] });
  await api(`/tasks/${id}/prompt`, "POST", { message: "何时交付？" });
  await api(`/tasks/${id}/stop`, "POST");
}
const detail = await api(`/tasks/${id}`);
const sources = await api(`/tasks/${id}/sources`);
assert.equal(detail.task.status, "stopped");
assert.equal(sources.items.length, 3);
assert.equal(detail.turns.length, 3);
assert.deepEqual(detail.turns.map((turn) => turn.result.status), ["answered","no_basis","conflict"]);
for (const turn of detail.turns) for (const claim of turn.result.claims) for (const citation of claim.citations) {
  const original = await api(`/tasks/${id}/sources/${citation.sourceId}`);
  assert.equal(original.source.text.slice(citation.start, citation.end), citation.quote);
}
console.log(JSON.stringify({ taskId: id, url: `${base}/tasks/${id}`, status: detail.task.status, sources: sources.items.length, results: detail.turns.map((turn) => turn.result.status) }));
