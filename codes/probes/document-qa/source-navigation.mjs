import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_PACKAGE_PATH);
const base = process.env.TEST_ADMIN_ORIGIN ?? "http://127.0.0.1:30206";
const id = process.env.PIWS_SHOWCASE_TASK;
assert.match(id, /^[0-9a-f-]{36}$/);
const browser = await chromium.launch({ channel: "msedge", headless: true });
try {
  for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
    const page = await browser.newPage({ viewport });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    assert.equal((await page.request.get(`${base}/api/v1/tasks/${id}/sources`)).status(), 401);
    await page.goto(`${base}/tasks/${id}`);
    await page.locator("#admin-key").fill(readFileSync(process.env.PIWS_ADMIN_KEY_FILE, "utf8").trim());
    await page.locator('#login-form button[type="submit"]').click();
    await page.locator(".citations a").first().waitFor();
    assert.equal((await page.request.post(`${base}/api/v1/tasks/${id}/sources`, { headers: { Origin: base }, data: { files: [] } })).status(), 403);
    assert.equal((await page.request.post(`${base}/api/v1/tasks/${id}/sources`, { headers: { Origin: "https://invalid.example" }, data: { files: [] } })).status(), 403);
    for (let round = 0; round < 10; round++) {
      await page.locator(".citations a").first().click();
      await page.waitForURL(/\/sources\/[0-9a-f-]{36}\?start=/);
      await page.locator("#source-original mark").waitFor();
      await page.reload();
      await page.locator("#source-original mark").waitFor();
      await page.locator("#back-task").click();
      await page.locator(".citations a").first().waitFor();
    }
    assert.deepEqual(errors, []);
    await page.close();
  }
} finally { await browser.close(); }
console.log("source navigation: 20 citation jumps, 20 reloads, unauthenticated source rejection, CSRF and Origin rejection passed");
