#!/usr/bin/env node
// Headless Chrome walkthrough: signs into FORGE as admin, navigates to a
// few canonical screens, exercises the new Details + bell + tab keyboard
// affordances, and saves PNG snapshots to /opt/cursor/artifacts/.

import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import CDP from "chrome-remote-interface";

const ART = "/opt/cursor/artifacts";
const TARGET = "http://localhost:3000";
const userDir = mkdtempSync(join(tmpdir(), "forge-headless-"));

const chrome = spawn("google-chrome", [
  "--headless=new",
  "--no-sandbox",
  "--disable-gpu",
  "--hide-scrollbars",
  `--user-data-dir=${userDir}`,
  "--remote-debugging-port=9333",
  "--window-size=1366,900",
  "about:blank",
], { stdio: ["ignore", "ignore", "ignore"] });

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  // Wait for chrome to come up
  for (let i = 0; i < 30; i++) {
    try {
      const r = await fetch("http://localhost:9333/json/version");
      if (r.ok) break;
    } catch {}
    await sleep(200);
  }

  const client = await CDP({ port: 9333 });
  const { Page, Runtime, Emulation, Network } = client;
  await Promise.all([Page.enable(), Runtime.enable(), Network.enable()]);
  await Emulation.setDeviceMetricsOverride({ width: 1366, height: 900, deviceScaleFactor: 1, mobile: false });

  async function go(url, settle = 1000) {
    await Page.navigate({ url });
    await Page.loadEventFired();
    await sleep(settle);
  }

  async function snap(name) {
    const { data } = await Page.captureScreenshot({ format: "png" });
    writeFileSync(`${ART}/${name}.png`, Buffer.from(data, "base64"));
    console.log("saved", name);
  }

  async function evalJs(expression) {
    const { result, exceptionDetails } = await Runtime.evaluate({
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (exceptionDetails) throw new Error(exceptionDetails.text + " " + JSON.stringify(exceptionDetails.exception));
    return result.value;
  }

  // 1) Anonymous landing → Hub redirect / route default. The SPA boots on
  //    the seeded demo state.
  await go(`${TARGET}/`);
  await snap("forge_v2_01_landing");

  // Navigate to home
  await evalJs(`location.hash = "#/home"`);
  await sleep(700);
  await snap("forge_v2_02_home_no_panel");

  // Toggle the new Details button to slide in the right context panel
  await evalJs(`
    (() => {
      const btns = [...document.querySelectorAll(".header-controls button")];
      const detailsBtn = btns.find(b => b.textContent.trim() === "Details");
      if (detailsBtn) detailsBtn.click();
    })();
  `);
  await sleep(500);
  await snap("forge_v2_03_home_details_open");

  // Click again to hide
  await evalJs(`
    (() => {
      const btns = [...document.querySelectorAll(".header-controls button")];
      const detailsBtn = btns.find(b => b.textContent.trim() === "Details");
      if (detailsBtn) detailsBtn.click();
    })();
  `);
  await sleep(400);

  // 2) Notification bell popover
  await evalJs(`
    (() => {
      const bell = document.querySelector(".notify-btn");
      if (bell) bell.click();
    })();
  `);
  await sleep(500);
  await snap("forge_v2_04_notification_bell");
  // Close popover
  await evalJs(`document.body.click();`);
  await sleep(300);

  // 3) Sign in via the app's exposed forge.login(). The reload triggers
  //    /api/me and the new role sync logic.
  await evalJs(`
    (async () => {
      if (window.forge?.login) await window.forge.login("admin@forge.local", "forge");
    })();
  `);
  await sleep(900);
  await evalJs(`location.reload();`);
  await Page.loadEventFired();
  await sleep(2500);
  await snap("forge_v2_05_signed_in_home");

  // 4) Navigate to incident and demo the FSM transition modal
  await evalJs(`location.hash = "#/incidents"`);
  await sleep(700);
  await evalJs(`
    (() => {
      const tr = document.querySelector("tr.row-clickable");
      if (tr) tr.click();
    })();
  `);
  await sleep(900);
  await snap("forge_v2_06_incident");
  // Click "Change status"
  await evalJs(`
    (() => {
      const btns = [...document.querySelectorAll("button")];
      const b = btns.find(x => x.textContent.trim() === "Change status");
      if (b) b.click();
    })();
  `);
  await sleep(500);
  await snap("forge_v2_07_incident_status_modal");
  // Close modal
  await evalJs(`
    (() => {
      const btns = [...document.querySelectorAll(".modal-footer button")];
      const cancel = btns.find(x => /Cancel/i.test(x.textContent));
      if (cancel) cancel.click();
    })();
  `);
  await sleep(400);

  // 5) Forbidden screen demo: lower role to Engineer, hit /admin. The
  //    role change goes through the dropdown so it persists; navigating
  //    is done via dispatchEvent because headless sometimes elides the
  //    hashchange event when hash is set within the same task.
  await evalJs(`
    (() => {
      const sel = document.querySelector(".header-controls select");
      if (sel) { sel.value = "Engineer/Contributor"; sel.dispatchEvent(new Event("change", { bubbles: true })); }
    })();
  `);
  await sleep(500);
  await Page.navigate({ url: TARGET + "/#/admin" });
  await sleep(2200);
  await snap("forge_v2_08_forbidden_detailed");

  // 6) Admin tabs keyboard navigation. Switch role back to Org Owner.
  await evalJs(`
    (() => {
      const sel = document.querySelector(".header-controls select");
      if (!sel) return;
      sel.value = "Organization Owner";
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    })();
  `);
  await sleep(400);
  await evalJs(`location.hash = "#/admin"`);
  await sleep(900);
  await snap("forge_v2_09_admin_identity");
  // Press End on the active tab via dispatchEvent
  await evalJs(`
    (() => {
      const tab = document.querySelector('[role="tab"][aria-selected="true"]');
      if (!tab) return;
      tab.focus();
      const ev = new KeyboardEvent("keydown", { key: "End", bubbles: true, cancelable: true });
      tab.dispatchEvent(ev);
    })();
  `);
  await sleep(500);
  await snap("forge_v2_10_admin_health_tab");

  // 7) Field mode — toggle via the View ▾ menu.
  await evalJs(`
    (() => {
      const view = [...document.querySelectorAll(".header-controls button")]
        .find(b => /View/.test(b.textContent));
      if (view) view.click();
    })();
  `);
  await sleep(300);
  await evalJs(`
    (() => {
      const fm = [...document.querySelectorAll(".vm-row")]
        .find(b => /Field mode/i.test(b.textContent));
      if (fm) fm.click();
    })();
  `);
  await sleep(600);
  await evalJs(`location.hash = "#/home"`);
  await sleep(700);
  await snap("forge_v2_11_field_mode");
  // Exit field mode
  await evalJs(`
    (() => {
      const view = [...document.querySelectorAll(".header-controls button")]
        .find(b => /View/.test(b.textContent));
      if (view) view.click();
      setTimeout(() => {
        const fm = [...document.querySelectorAll(".vm-row")]
          .find(b => /Exit field mode/i.test(b.textContent));
        if (fm) fm.click();
      }, 100);
    })();
  `);
  await sleep(500);

  // 8) Hub default in-tab navigation. Anonymous mode style screenshot.
  await evalJs(`location.hash = "#/hub"`);
  await sleep(700);
  await snap("forge_v2_12_hub");

  // 9) Mobile shell snapshot
  await Emulation.setDeviceMetricsOverride({ width: 700, height: 900, deviceScaleFactor: 1, mobile: true });
  await sleep(400);
  await evalJs(`location.hash = "#/home"`);
  await sleep(700);
  await snap("forge_v2_13_mobile_home");

  await client.close();
  chrome.kill("SIGTERM");
})().catch(err => {
  console.error("walkthrough failed:", err);
  chrome.kill("SIGTERM");
  process.exit(1);
});
