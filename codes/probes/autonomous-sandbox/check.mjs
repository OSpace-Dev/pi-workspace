import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

// Windows drives orchestration; all application and database checks run in WSL Docker.
const wsl = (...args) => execFileSync("wsl.exe", ["-d", process.env.PIWS_WSL_DISTRO ?? "Ubuntu-22.04", "--exec", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const origin = "http://127.0.0.1:30208";
const scope = "piws-autonomous-acceptance";
const adminKey = wsl("docker", "exec", `${scope}-api-1`, "cat", "/run/secrets/admin_key");
let cookie = "", csrf = "";
async function api(path, method = "GET", body) {
  const response = await fetch(`${origin}/api/v1${path}`, { method,
    headers: { Origin: origin, Cookie: cookie, "X-CSRF-Token": csrf, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(90_000) });
  if (response.headers.get("set-cookie")) cookie = response.headers.get("set-cookie").split(";")[0];
  return { status: response.status, data: response.status === 204 ? null : await response.json() };
}
const login = await api("/login", "POST", { key: adminKey });
assert.equal(login.status, 200); csrf = login.data.csrfToken;
assert.equal(wsl("docker", "exec", `${scope}-db-1`, "psql", "-U", "pi_workspace", "-d", "pi_workspace", "-Atc", "SELECT count(*) FROM model_connections"), "0");
assert.equal((await api("/sandboxes", "POST", { name: "wrong", connectionId: "legacy" })).status, 400);
assert.equal((await api("/sandboxes", "POST", { name: " " })).status, 400);
const ids = [];
let browser;
const output = resolve("docs/testing/evidence/autonomous-sandbox");
mkdirSync(output, { recursive: true });
try {
  // Prove that the model proxy is not a startup or model-request dependency.
  wsl("docker", "stop", `${scope}-proxy-1`);
  for (const name of ["Autonomous A", "Autonomous B"]) {
    const created = await api("/sandboxes", "POST", { name });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    assert.equal(created.data.task.mode, "autonomous"); ids.push(created.data.task.id);
  }
  const accesses = [];
  for (const id of ids) {
    const detail = await api(`/sandboxes/${id}`);
    assert.equal(detail.data.ready, true, JSON.stringify(detail));
    assert.equal(detail.data.containerState, "running");
    assert.ok(detail.data.observedAt);
    assert.equal((await api(`/tasks/${id}`)).status, 404);
    const access = await api(`/sandboxes/${id}/access`);
    assert.equal(access.status, 200); accesses.push(access.data);
    const inspect = JSON.parse(wsl("docker", "inspect", `piws-sandbox-${id}`))[0];
    assert.equal(inspect.Config.User, "10001:10001");
    assert.equal(inspect.HostConfig.Privileged, false);
    assert.equal(inspect.HostConfig.ReadonlyRootfs, true);
    assert.equal(inspect.HostConfig.Memory, 768 * 1024 * 1024);
    assert.deepEqual(Object.keys(inspect.NetworkSettings.Networks), [`piws-agent-${id}`]);
    assert.deepEqual(inspect.Mounts.map((item) => item.Destination).sort(), ["/data/pi-agent", "/workspace"]);
    assert.ok(inspect.Mounts.every((item) => item.Source.includes(`/autonomous/${id}/`)));
    assert.equal(inspect.Config.Env.some((value) => /TOKEN|MASTER_KEY|SERVICE_KEY|ADMIN_KEY|PROXY/.test(value)), false);
    assert.equal(wsl("docker", "exec", `piws-sandbox-${id}`, "node", "-e", "console.log(require('fs').existsSync('/data/pi-agent/models.json'))"), "false");
    const network = JSON.parse(wsl("docker", "network", "inspect", `piws-agent-${id}`))[0];
    assert.equal(network.Internal, false); assert.equal(network.Labels["piws.scope"], scope);
  }
  assert.notEqual(accesses[0].password, accesses[1].password);
  assert.notEqual(accesses[0].url, accesses[1].url);
  const [a, b] = ids;
  wsl("docker", "run", "-d", "--name", "piws-autonomous-fixture", "--label", `piws.scope=${scope}`,
    "--network", `piws-agent-${a}`, "--network-alias", "fixture", "-v",
    `${wsl("wslpath", "-a", resolve("codes/probes/autonomous-sandbox/fixture.mjs"))}:/fixture.mjs:ro`, "node:24-bookworm-slim", "node", "/fixture.mjs");
  assert.equal(wsl("docker", "exec", `piws-sandbox-${b}`, "node", "-e",
    "fetch('http://fixture:30300/v1/models',{signal:AbortSignal.timeout(2000)}).then(()=>process.exit(1)).catch(()=>process.exit(0))"), "");
  const auth = { Authorization: `Basic ${Buffer.from(`pi:${accesses[0].password}`).toString("base64")}`, Origin: accesses[0].url };
  const unauthenticated = await fetch(`${accesses[0].url}/api/models-config`, { redirect: "manual" });
  assert.equal(unauthenticated.status, 401);
  const webApi = async (path, method = "GET", data) => {
    const response = await fetch(`${accesses[0].url}${path}`, { method, headers: { ...auth, "Content-Type": "application/json" },
      body: data === undefined ? undefined : JSON.stringify(data) });
    assert.equal(response.status, 200, await response.clone().text()); return response.json();
  };
  const config = { providers: { autonomous: { baseUrl: "http://fixture:30300/v1", api: "openai-completions", apiKey: "synthetic-sandbox-only",
    models: [{ id: "independent-test", name: "Independent test", contextWindow: 8192, maxTokens: 1024, input: ["text"],
      compat: { supportsStore: false, supportsReasoningEffort: false } }] } } };
  await webApi("/api/models-config", "PUT", config);
  assert.deepEqual(await webApi("/api/models-config"), config);
  assert.equal(wsl("docker", "exec", `piws-sandbox-${b}`, "node", "-e", "console.log(require('fs').existsSync('/data/pi-agent/models.json'))"), "false");
  wsl("docker", "exec", "-u", "10001:10001", `piws-sandbox-${a}`, "node", "-e", "require('fs').writeFileSync('/workspace/retained.txt','retained')");
  assert.equal(wsl("docker", "exec", `piws-sandbox-${b}`, "node", "-e", "console.log(require('fs').existsSync('/workspace/retained.txt'))"), "false");
  const dbCounts = wsl("docker", "exec", `${scope}-db-1`, "psql", "-U", "pi_workspace", "-d", "pi_workspace", "-Atc",
    "SELECT (SELECT count(*) FROM model_connections),(SELECT count(*) FROM model_proxy_tasks),(SELECT count(*) FROM task_proxy_grants),(SELECT count(*) FROM agent_sandboxes)");
  assert.equal(dbCounts, "0|0|0|2");
  const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_PACKAGE_PATH);
  browser = await chromium.launch({ channel: "msedge", headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "zh-CN" });
  const page = await context.newPage();
  const errors = []; page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${origin}/sandboxes/${a}`);
  await page.locator("#admin-key").fill(adminKey);
  await page.locator('#login-form button[type="submit"]').click();
  await page.locator("#workspace").waitFor({ state: "visible" });
  await page.locator("#open-sandbox:not([disabled])").waitFor();
  assert.equal(await page.locator("#probe-container").innerText(), "运行");
  await page.screenshot({ path: resolve(output, "desktop.png"), fullPage: true });
  const web = await context.newPage();
  await web.goto(`${accesses[0].url}/login`);
  await web.locator('input[type="password"]').fill(accesses[0].password);
  await web.getByRole("button", { name: "登录", exact: true }).click();
  await web.waitForURL((url) => !url.pathname.endsWith("/login"));
  await web.screenshot({ path: resolve(output, "pi-web-home.png"), fullPage: true });
  await web.getByRole("button", { name: "模型", exact: true }).click();
  await web.getByText("autonomous", { exact: true }).first().waitFor();
  await web.getByText("autonomous", { exact: true }).first().click();
  await web.getByText("independent-test", { exact: false }).first().waitFor();
  await web.getByRole("button", { name: "保存", exact: true }).click();
  assert.deepEqual(await webApi("/api/models-config"), config);
  await web.screenshot({ path: resolve(output, "pi-web-models.png"), fullPage: true });
  await web.keyboard.press("Escape");
  if (!await web.locator("textarea.chat-input-textarea").count()) {
    await web.getByRole("button", { name: /选择项目/ }).click();
    await web.getByRole("button", { name: "自定义路径…" }).click();
    if (await web.getByRole("button", { name: "workspace", exact: true }).count()) {
      await web.getByRole("button", { name: "workspace", exact: true }).click();
    }
    await web.getByRole("button", { name: "选择此文件夹" }).click();
    await web.locator("textarea.chat-input-textarea").waitFor();
  }
  await web.screenshot({ path: resolve(output, "pi-web-selected.png"), fullPage: true });
  const editor = web.locator("textarea.chat-input-textarea");
  await editor.fill("Independent configuration test");
  await web.getByRole("button", { name: "发送", exact: true }).click();
  await web.getByText("Independent sandbox answer.", { exact: false }).first().waitFor({ timeout: 20_000 });
  await web.screenshot({ path: resolve(output, "pi-web-answer.png"), fullPage: true });
  assert.equal((await api(`/sandboxes/${a}/stop`, "POST")).status, 200);
  assert.equal((await api(`/sandboxes/${a}`)).data.containerState, "exited");
  assert.equal((await api(`/sandboxes/${a}/access`)).status, 409);
  assert.equal((await api(`/sandboxes/${a}/resume`, "POST")).status, 200);
  const resumed = (await api(`/sandboxes/${a}/access`)).data;
  assert.equal(resumed.password, accesses[0].password);
  assert.equal(wsl("docker", "exec", `piws-sandbox-${a}`, "cat", "/workspace/retained.txt"), "retained");
  const savedConfig = JSON.parse(wsl("docker", "exec", `piws-sandbox-${a}`, "cat", "/data/pi-agent/models.json"));
  assert.deepEqual(savedConfig, config);
  await web.goto(`${resumed.url}/login`);
  if (web.url().endsWith("/login")) {
    await web.locator('input[type="password"]').fill(resumed.password);
    await web.getByRole("button", { name: "登录", exact: true }).click();
    await web.waitForURL((url) => !url.pathname.endsWith("/login"));
  }
  await web.getByText("Independent configuration test", { exact: true }).first().click();
  await web.getByText("Independent sandbox answer.", { exact: false }).first().waitFor();
  await web.screenshot({ path: resolve(output, "pi-web-resumed.png"), fullPage: true });
  await page.reload(); await page.locator("#workspace").waitFor({ state: "visible" });
  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "zh-CN" });
  const phone = await mobile.newPage(); await phone.goto(`${origin}/sandboxes/${a}`);
  await phone.locator("#admin-key").fill(adminKey); await phone.locator('#login-form button[type="submit"]').click();
  await phone.locator("#workspace").waitFor({ state: "visible" });
  await phone.screenshot({ path: resolve(output, "mobile.png"), fullPage: true });
  assert.equal(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(errors, []);
  const listPage = await context.newPage();
  await listPage.goto(`${origin}/sandboxes`);
  await listPage.locator("#workspace").waitFor({ state: "visible" });
  await listPage.locator("#create-sandbox-open").click();
  assert.equal(await listPage.locator("#sandbox-connection-select").count(), 0);
  await listPage.locator("#sandbox-name").fill("Browser-created sandbox");
  await listPage.screenshot({ path: resolve(output, "create.png"), fullPage: true });
  await listPage.locator('#create-sandbox-form button[type="submit"]').click();
  await listPage.waitForURL(/\/sandboxes\/[0-9a-f-]{36}$/);
  const browserId = new URL(listPage.url()).pathname.split("/").at(-1); ids.push(browserId);
  await listPage.locator("#open-sandbox:not([disabled])").waitFor();
  await listPage.locator("#stop-sandbox").click();
  await listPage.locator("#resume-sandbox").waitFor({ state: "visible" });
  await listPage.locator("#delete-sandbox-open").click();
  await listPage.locator("#delete-sandbox-confirm").click();
  await listPage.waitForURL(`${origin}/sandboxes`);
  assert.equal((await api(`/sandboxes/${browserId}`)).status, 404);
  ids.splice(ids.indexOf(browserId), 1);
  await mobile.close(); await context.close();
  wsl("docker", "stop", `piws-sandbox-${b}`);
  assert.equal((await api(`/sandboxes/${b}`)).data.running, false);
  wsl("docker", "stop", `${scope}-runtime-1`);
  assert.equal((await api(`/sandboxes/${a}`)).data.containerState, "unknown");
  wsl("docker", "start", `${scope}-runtime-1`);
  for (let attempt = 0; attempt < 30; attempt++) {
    if ((await api(`/sandboxes/${a}`)).data.containerState !== "unknown") break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.equal((await api(`/sandboxes/${a}`)).data.containerState, "running");
  console.log(JSON.stringify({ result: "autonomous configuration, proxy independence, isolation, lifecycle and desktop/mobile passed", ids }));
} finally {
  await browser?.close();
  try { wsl("docker", "rm", "-f", "piws-autonomous-fixture"); } catch {}
  for (const id of ids) {
    const deleted = await api(`/sandboxes/${id}`, "DELETE");
    assert.equal(deleted.status, 204, JSON.stringify(deleted));
    assert.equal((await api(`/sandboxes/${id}`)).status, 404);
  }
}
