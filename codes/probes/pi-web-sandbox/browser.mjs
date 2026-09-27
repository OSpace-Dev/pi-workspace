import assert from "node:assert/strict";
import { readFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_PACKAGE_PATH);
const key = readFileSync(process.env.PIWS_ADMIN_KEY_FILE, "utf8").trim();
const base = process.env.TEST_ADMIN_ORIGIN ?? "http://127.0.0.1:30208";
const output = resolve("docs/testing/evidence/pi-web-sandbox");
mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ channel: "msedge", headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const existingId = process.env.TEST_SANDBOX_ID;
  await page.goto(existingId ? `${base}/sandboxes/${existingId}` : `${base}/sandboxes`);
  await page.locator("#admin-key").fill(key);
  await page.locator('#login-form button[type="submit"]').click();
  await page.locator("#workspace").waitFor({ state: "visible" });
  if (!existingId) {
    await page.locator("#create-sandbox-open").click();
    await page.locator("#sandbox-name").fill("Pi Web 浏览器验收");
    await page.locator('#create-sandbox-form button[type="submit"]').click();
  await page.waitForURL(/\/sandboxes\/[0-9a-f-]{36}$/);
  }
  await page.locator("#open-sandbox:not([disabled])").waitFor({ timeout: 30000 });
  await page.screenshot({ path: resolve(output, "desktop-sandbox.png"), fullPage: true });
  await page.locator("#reveal-password").click();
  await page.waitForFunction(() => document.getElementById("sandbox-password").value.length >= 32);
  const password = await page.locator("#sandbox-password").inputValue();
  assert.ok(password.length >= 32);
  const targetUrl = await page.locator("#sandbox-url").innerText();
  const [web] = await Promise.all([context.waitForEvent("page"), page.locator("#open-sandbox").click()]);
  for (let attempt = 0; attempt < 5; attempt++) {
    try { await web.goto(`${targetUrl}/login`, { waitUntil: "domcontentloaded" }); break; }
    catch (error) { if (attempt === 4) throw error; await web.waitForTimeout(500); }
  }
  await web.waitForLoadState("domcontentloaded");
  await web.screenshot({ path: resolve(output, "pi-web-login.png"), fullPage: true });
  await web.locator('input[type="password"]').fill("invalid-password");
  await web.getByRole("button", { name: "登录" }).click();
  await web.waitForTimeout(1300);
  assert.match(web.url(), /\/login$/);
  await web.locator('input[type="password"]').fill(password);
  await web.getByRole("button", { name: "登录" }).click();
  await web.waitForTimeout(700);
  await web.screenshot({ path: resolve(output, "pi-web-after-login.png"), fullPage: true });
  await web.waitForURL((url) => !url.pathname.endsWith("/login"), { timeout: 10000 });
  await web.reload({ waitUntil: "domcontentloaded" });
  await web.screenshot({ path: resolve(output, "pi-web-home.png"), fullPage: true });
  if (!await web.locator("textarea.chat-input-textarea").count()) {
    await web.getByRole("button", { name: /选择项目/ }).click();
    await web.getByRole("button", { name: "自定义路径…" }).click();
    await web.getByRole("button", { name: "workspace", exact: true }).click();
    await web.getByRole("button", { name: "选择此文件夹" }).click();
    await web.locator("textarea.chat-input-textarea").waitFor();
  }
  await web.screenshot({ path: resolve(output, "pi-web-selected.png"), fullPage: true });
  const editor = web.locator("textarea.chat-input-textarea");
  await editor.fill("Browser sandbox model test");
  await web.getByRole("button", { name: "发送" }).click();
  await web.getByText("Synthetic answer.", { exact: false }).first().waitFor({ timeout: 5000 });
  await web.screenshot({ path: resolve(output, "pi-web-answer.png"), fullPage: true });
  await editor.fill("CASE:tool create a sandbox file");
  await web.getByRole("button", { name: "发送" }).click();
  await web.getByText("sandbox-tool-check.txt", { exact: false }).first().waitFor({ timeout: 15000 });
  await web.waitForTimeout(1000);
  await web.screenshot({ path: resolve(output, "pi-web-tool.png"), fullPage: true });
  await web.reload({ waitUntil: "domcontentloaded" });
  await web.getByText("Synthetic answer.", { exact: false }).first().waitFor({ timeout: 10000 });
  assert.ok((await web.locator("body").innerText()).includes("Synthetic answer."));
  await web.close();
  await page.locator("#stop-sandbox").click();
  await page.locator("#resume-sandbox").waitFor({ state: "visible" });
  await page.locator("#resume-sandbox").click();
  await page.locator("#open-sandbox:not([disabled])").waitFor({ timeout: 30000 });
  const resumedUrl = await page.locator("#sandbox-url").innerText();
  const resumedWeb = await context.newPage();
  for (let attempt = 0; attempt < 5; attempt++) {
    try { await resumedWeb.goto(`${resumedUrl}/login`, { waitUntil: "domcontentloaded" }); break; }
    catch (error) { if (attempt === 4) throw error; await resumedWeb.waitForTimeout(500); }
  }
  if (resumedWeb.url().endsWith("/login")) {
    await resumedWeb.locator('input[type="password"]').fill(password);
    await resumedWeb.getByRole("button", { name: "登录" }).click();
    await resumedWeb.waitForURL((url) => !url.pathname.endsWith("/login"), { timeout: 10000 });
  }
  if (!await resumedWeb.locator("textarea.chat-input-textarea").count()) {
    await resumedWeb.getByRole("button", { name: /选择项目/ }).click();
    await resumedWeb.getByRole("button", { name: "自定义路径…" }).click();
    await resumedWeb.getByRole("button", { name: "workspace", exact: true }).click();
    await resumedWeb.getByRole("button", { name: "选择此文件夹" }).click();
  }
  await resumedWeb.getByText("Browser sandbox model test", { exact: true }).first().click();
  await resumedWeb.getByText("Synthetic answer.", { exact: false }).first().waitFor({ timeout: 10000 });
  await resumedWeb.screenshot({ path: resolve(output, "pi-web-resumed-session.png"), fullPage: true });
  assert.deepEqual(errors, []);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  console.log(JSON.stringify({ adminUrl: page.url(), webUrl: resumedWeb.url(),
    result: "login, model answer, session reload, stop and resume passed" }));
  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const mobilePage = await mobile.newPage();
  await mobilePage.goto(page.url());
  await mobilePage.locator("#admin-key").fill(key);
  await mobilePage.locator('#login-form button[type="submit"]').click();
  await mobilePage.locator("#workspace").waitFor({ state: "visible" });
  await mobilePage.screenshot({ path: resolve(output, "mobile-sandbox.png"), fullPage: true });
  assert.equal(await mobilePage.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await mobile.close();
  await context.close();
} finally { await browser.close(); }
