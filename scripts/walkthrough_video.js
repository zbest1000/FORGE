#!/usr/bin/env node
// Drive a visible Chrome window through the new UX so RecordScreen can
// capture the demo. We launch Chrome non-headless via Xvfb (the cloud agent
// VM ships one), connect via DevTools Protocol, and step through the
// improvements with deliberate pacing.

import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import CDP from "chrome-remote-interface";

const TARGET = "http://localhost:3000";
const userDir = mkdtempSync(join(tmpdir(), "forge-visible-"));

// Use existing X display if present (cloud agents have one); otherwise
// xvfb-run will be used by the caller.
const chrome = spawn("google-chrome", [
  "--no-sandbox",
  `--user-data-dir=${userDir}`,
  "--remote-debugging-port=9334",
  "--window-size=1366,860",
  "--window-position=0,0",
  "--start-fullscreen",
  "--disable-features=Translate",
  "about:blank",
], { stdio: ["ignore", "ignore", "ignore"], env: { ...process.env, DISPLAY: process.env.DISPLAY || ":1" } });

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch("http://localhost:9334/json/version")).ok) break; } catch {}
    await sleep(200);
  }
  const client = await CDP({ port: 9334 });
  const { Page, Runtime, Emulation } = client;
  await Promise.all([Page.enable(), Runtime.enable()]);
  await Emulation.setDeviceMetricsOverride({ width: 1366, height: 860, deviceScaleFactor: 1, mobile: false });

  async function go(url, settle = 1500) {
    await Page.navigate({ url });
    await Page.loadEventFired();
    await sleep(settle);
  }
  async function evalJs(expression, awaitPromise = false) {
    return Runtime.evaluate({ expression, awaitPromise, returnByValue: true });
  }

  // Boot fresh — clear any persisted state from prior runs so we always
  // start in the audit's recommended default (context panel collapsed,
  // dock off, role = engineer).
  await go(`${TARGET}/?__r=` + Date.now() + "#/home", 800);
  await evalJs(`localStorage.clear(); sessionStorage.clear();`);
  await go(`${TARGET}/?__r0=` + Date.now() + "#/home", 2000);

  // Sign in
  await evalJs(`window.forge.login("admin@forge.local","forge")`, true);
  await sleep(1200);
  await go(`${TARGET}/?__r2=` + Date.now() + "#/home", 2000);

  // 1. Toggle Details panel
  await evalJs(`[...document.querySelectorAll(".header-controls button")].find(b => b.textContent.trim() === "Details")?.click()`);
  await sleep(1500);
  await evalJs(`[...document.querySelectorAll(".header-controls button")].find(b => b.textContent.trim() === "Details")?.click()`);
  await sleep(1200);

  // 2. Notification bell
  await evalJs(`document.querySelector(".notify-btn")?.click()`);
  await sleep(2200);
  await evalJs(`document.body.click()`);
  await sleep(800);

  // 3. Incident — open Change status modal
  await go(`${TARGET}/?__r3=` + Date.now() + "#/incident/INC-4412", 2000);
  await evalJs(`[...document.querySelectorAll("button")].find(b => b.textContent.trim() === "Change status")?.click()`);
  await sleep(2500);
  // Cancel
  await evalJs(`[...document.querySelectorAll(".modal-footer button")].find(b => /Cancel/.test(b.textContent))?.click()`);
  await sleep(700);

  // 4. Forbidden screen
  await evalJs(`(() => { const sel = document.querySelector(".header-controls select"); sel.value = "Engineer/Contributor"; sel.dispatchEvent(new Event("change", { bubbles: true })); })()`);
  await sleep(800);
  await go(`${TARGET}/?__r4=` + Date.now() + "#/admin", 2500);
  await sleep(1500);

  // 5. Click Request access
  await evalJs(`[...document.querySelectorAll(".forbidden button")].find(b => /Request access/.test(b.textContent))?.click()`);
  await sleep(2000);

  // Switch role back
  await evalJs(`(() => { const sel = document.querySelector(".header-controls select"); sel.value = "Organization Owner"; sel.dispatchEvent(new Event("change", { bubbles: true })); })()`);
  await sleep(800);

  // 6. Hub in-tab navigation. Clicking a tile dispatches the SPA's onClick
  //    which calls e.preventDefault() and sets location.hash — so the
  //    same tab navigates to the portal. Use a real MouseEvent dispatch
  //    so the JS handler runs (rather than the anchor's default action).
  await go(`${TARGET}/?__r5=` + Date.now() + "#/hub", 2200);
  await evalJs(`(() => {
    const tile = [...document.querySelectorAll(".hub-tile")].find(t => /Engineering(?!\\s+&)/.test(t.textContent));
    if (!tile) return false;
    tile.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window, button: 0 }));
    return true;
  })()`);
  await sleep(2400);

  // 7. Admin tabs keyboard nav
  await go(`${TARGET}/?__r6=` + Date.now() + "#/admin", 2000);
  await evalJs(`(() => {
    const tab = document.querySelector('[role="tab"][aria-selected="true"]');
    if (!tab) return;
    tab.focus();
    tab.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
  })()`);
  await sleep(1100);
  await evalJs(`(() => {
    const tab = document.querySelector('[role="tab"][aria-selected="true"]');
    if (!tab) return;
    tab.focus();
    tab.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
  })()`);
  await sleep(1100);
  await evalJs(`(() => {
    const tab = document.querySelector('[role="tab"][aria-selected="true"]');
    if (!tab) return;
    tab.focus();
    tab.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
  })()`);
  await sleep(1500);

  await client.close();
  chrome.kill("SIGTERM");
})().catch(err => { console.error(err); chrome.kill("SIGTERM"); process.exit(1); });
