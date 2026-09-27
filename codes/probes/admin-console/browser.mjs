import assert from "node:assert/strict";
import { readFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

if (!process.env.PLAYWRIGHT_PACKAGE_PATH || !process.env.PIWS_ADMIN_KEY_FILE) throw new Error("Browser test dependency and key file paths are required");
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_PACKAGE_PATH);
const base = process.env.TEST_ADMIN_ORIGIN ?? "http://127.0.0.1:30202";
const key = readFileSync(process.env.PIWS_ADMIN_KEY_FILE, "utf8").trim();
const output = resolve(process.env.TEST_SCREENSHOT_DIR ?? "docs/testing/evidence/product-model-proxy");
mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ channel: "msedge", headless: true });
try {
  for (const [label, viewport] of [["desktop", { width: 1280, height: 800 }], ["mobile", { width: 390, height: 844 }]]) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", () => errors.push("pageerror"));
    await page.goto(`${base}/models/connections`);
    await page.locator("#login-view").waitFor({ state: "visible" });
    await page.locator("#admin-key").fill(key);
    await page.locator('#login-form button[type="submit"]').click();
    await page.locator("#workspace").waitFor({ state: "visible" });
    assert.equal(await page.locator("#admin-key").inputValue(), "");
    await page.locator("#create-open").click();
    await page.locator("#create-dialog").waitFor({ state: "visible" });
    await page.locator('#create-dialog [data-close="create-dialog"]').first().click();
    await page.screenshot({ path: resolve(output, `${label}-connections.png`), fullPage: true });
    await page.locator('[data-view="origins"]').click();
    await page.locator("#origins-view").waitFor({ state: "visible" });
    assert.equal(new URL(page.url()).pathname, "/models/origins");
    await page.reload();
    await page.locator("#origins-view").waitFor({ state: "visible" });
    assert.equal(await page.locator("#connections-view").isVisible(), false);
    const noOverflow = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
    assert.equal(noOverflow, true);
    await page.screenshot({ path: resolve(output, `${label}-origins.png`), fullPage: true });
    await page.locator("#logout").click();
    await page.locator("#login-view").waitFor({ state: "visible" });
    assert.deepEqual(errors, []);
    await context.close();
    console.log(`${label}: login, dialog, navigation, reload, no overflow, logout passed`);
  }
} finally {
  await browser.close();
}
