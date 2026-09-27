import assert from "node:assert/strict";
import { readFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_PACKAGE_PATH);
const key = readFileSync(process.env.PIWS_ADMIN_KEY_FILE, "utf8").trim();
const base = process.env.TEST_ADMIN_ORIGIN ?? "http://127.0.0.1:30204";
const output = resolve("docs/testing/evidence/pi-task-runtime");
mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ channel: "msedge", headless: true });
try {
  for (const [name, viewport] of [["desktop", { width: 1280, height: 800 }], ["mobile", { width: 390, height: 844 }]]) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${base}/tasks`);
    await page.locator("#admin-key").fill(key);
    await page.locator('#login-form button[type="submit"]').click();
    await page.locator("#workspace").waitFor({ state: "visible" });
    await page.locator("#create-task-open").click();
    await page.locator("#create-task-dialog").waitFor({ state: "visible" });
    const options = await page.locator("#task-connection option").all();
    await page.locator("#task-connection").selectOption(await options[0].getAttribute("value"));
    await page.locator('#create-task-form button[type="submit"]').click();
    await page.waitForURL(/\/tasks\/[0-9a-f-]{36}$/);
    await page.locator("#prompt-form").waitFor({ state: "visible" });
    await page.locator("#prompt-input").fill("Browser acceptance question");
    await page.locator("#send-prompt").click();
    await page.locator(".turn-answer").filter({ hasText: "Synthetic answer." }).waitFor();
    await page.screenshot({ path: resolve(output, `${name}-task.png`), fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.locator("#stop-task").click();
    await page.locator("#resume-task").waitFor({ state: "visible" });
    await page.reload();
    await page.locator("#resume-task").waitFor({ state: "visible" });
    await page.locator("#resume-task").click();
    await page.locator("#prompt-form").waitFor({ state: "visible" });
    await page.locator("#delete-task-open").click();
    await page.locator("#delete-task-dialog").waitFor({ state: "visible" });
    await page.screenshot({ path: resolve(output, `${name}-delete.png`), fullPage: true });
    await page.locator("#delete-task-confirm").click();
    await page.waitForURL(`${base}/tasks`);
    await page.locator("#task-list-view").waitFor({ state: "visible" });
    await page.locator('.top-links a[href="/models/connections"]').click();
    await page.locator("#connections-view").waitFor({ state: "visible" });
    await page.locator('.top-links a[href="/tasks"]').click();
    await page.locator("#task-list-view").waitFor({ state: "visible" });
    await page.locator("#logout").click();
    await page.locator("#login-view").waitFor({ state: "visible" });
    assert.deepEqual(errors, []);
    await context.close();
    console.log(`${name}: create, question, stop, reload, resume, delete, navigation and overflow passed`);
  }
} finally { await browser.close(); }
