// FORGE — bootstrap. Wires seed → store → router → shell → screens.

import { buildSeed } from "./src/data/seed.js";
import { state, initState, subscribe, registerAuditImpl } from "./src/core/store.js";
import { defineRoute, startRouter, rerenderCurrent } from "./src/core/router.js";
import { openPalette } from "./src/core/palette.js";
import { initI3X } from "./src/core/i3x/client.js";
import { normalizeSeed } from "./src/core/normalize.js";
import * as auditMod from "./src/core/audit.js";
import { initAuditLedger } from "./src/core/audit.js";
import { buildIndex, scheduleRebuild } from "./src/core/search.js";
import { installHotkeys } from "./src/core/hotkeys.js";

import { renderRail } from "./src/shell/rail.js";
import { renderLeftPanel } from "./src/shell/leftPanel.js";
import { renderHeader } from "./src/shell/header.js";
import { renderContextPanel } from "./src/shell/contextPanel.js";
import { renderDock } from "./src/shell/dock.js";

import { renderHome } from "./src/screens/home.js";
import { renderInbox } from "./src/screens/inbox.js";
import { renderSearch } from "./src/screens/search.js";
import { renderTeamSpacesIndex, renderTeamSpace } from "./src/screens/teamSpaces.js";
import { renderChannel } from "./src/screens/channel.js";
import { renderProjectsIndex, renderWorkBoard } from "./src/screens/workBoard.js";
import { renderDocsIndex, renderDocViewer } from "./src/screens/docViewer.js";
import { renderRevisionCompare } from "./src/screens/revisionCompare.js";
import { renderDrawingsIndex, renderDrawingViewer } from "./src/screens/drawingViewer.js";
import { renderAssetsIndex, renderAssetDetail } from "./src/screens/assetDetail.js";
import { renderIncidentsIndex, renderIncident } from "./src/screens/incident.js";
import { renderApprovals } from "./src/screens/approvals.js";
import { renderAI } from "./src/screens/ai.js";
import { renderIntegrations } from "./src/screens/integrations.js";
import { renderMQTT } from "./src/screens/mqtt.js";
import { renderOPCUA } from "./src/screens/opcua.js";
import { renderERP } from "./src/screens/erp.js";
import { renderAdmin } from "./src/screens/admin.js";
import { renderDashboards } from "./src/screens/dashboards.js";
import { renderSpec } from "./src/screens/spec.js";
import { renderUNSIndex } from "./src/screens/uns.js";
import { renderI3X } from "./src/screens/i3x.js";

function setupRoutes() {
  defineRoute("/home", renderHome);
  defineRoute("/inbox", renderInbox);
  defineRoute("/search", renderSearch);

  defineRoute("/team-spaces", renderTeamSpacesIndex);
  defineRoute("/team-space/:id", renderTeamSpace);

  defineRoute("/channel/:id", renderChannel);

  defineRoute("/projects", renderProjectsIndex);
  defineRoute("/work-board/:id", renderWorkBoard);

  defineRoute("/docs", renderDocsIndex);
  defineRoute("/doc/:id", renderDocViewer);
  defineRoute("/compare/:left/:right", renderRevisionCompare);

  defineRoute("/drawings", renderDrawingsIndex);
  defineRoute("/drawing/:id", renderDrawingViewer);

  defineRoute("/assets", renderAssetsIndex);
  defineRoute("/asset/:id", renderAssetDetail);

  defineRoute("/incidents", renderIncidentsIndex);
  defineRoute("/incident/:id", renderIncident);

  defineRoute("/approvals", renderApprovals);
  defineRoute("/ai", renderAI);

  defineRoute("/integrations", renderIntegrations);
  defineRoute("/integrations/mqtt", renderMQTT);
  defineRoute("/integrations/opcua", renderOPCUA);
  defineRoute("/integrations/erp", renderERP);

  defineRoute("/dashboards", renderDashboards);
  defineRoute("/admin", renderAdmin);
  defineRoute("/spec", renderSpec);

  defineRoute("/uns", renderUNSIndex);
  defineRoute("/i3x", renderI3X);
}

function applyTheme() {
  document.body.className = state.ui.theme === "dark" ? "theme-dark" : "theme-light";
}

function renderShell() {
  renderRail();
  renderLeftPanel();
  renderHeader();
  renderContextPanel();
  renderDock();
}

function attachHotkeys() {
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      openPalette();
    }
  });
}

function boot() {
  const seed = normalizeSeed(buildSeed());
  initState(seed);
  registerAuditImpl(auditMod);
  initAuditLedger();
  initI3X(state.data);
  buildIndex();
  applyTheme();
  setupRoutes();
  attachHotkeys();
  installHotkeys();

  subscribe(() => {
    applyTheme();
    renderShell();
    rerenderCurrent();
    scheduleRebuild();
  });

  // Re-render the UNS browser at a slow cadence so VQT values refresh live.
  // The i3X explorer is NOT auto-refreshed because the user edits request
  // bodies there and we must not wipe input focus.
  setInterval(() => {
    if ((state.route || "").startsWith("/uns")) {
      // Skip refresh when a modal or palette is open.
      if (document.querySelector(".modal-backdrop, .palette-backdrop")) return;
      rerenderCurrent();
    }
  }, 1500);

  startRouter();
  renderShell();
}

boot();

// Self-test suite (console only). Run `__forgeSelfTest()` in DevTools.
window.__forgeSelfTest = async function () {
  const d = state.data;
  const results = [];
  const check = (name, cond, detail) => {
    results.push({ name, pass: !!cond, detail });
    console.assert(cond, name + " — " + (detail || ""));
  };

  check("documents seeded", d.documents.length >= 3);
  check("revisions seeded", d.revisions.length >= 4);
  check("incidents seeded", d.incidents.length >= 1);
  check("work items seeded", d.workItems.length >= 5);
  check("§4 base fields on workItem", ["org_id","created_by","acl","audit_ref","labels"].every(k => k in d.workItems[0]));

  try {
    const { verifyLedger, exportAuditPack, verifyAuditPack } = await import("./src/core/audit.js");
    const v = await verifyLedger();
    check("audit ledger intact", v.ok, `strict=${v.strictCount}`);
    const pack = await exportAuditPack();
    check("audit pack verifies", await verifyAuditPack(pack), `entries=${pack.entry_count}`);
  } catch (e) { check("audit module", false, e.message); }

  try {
    const search = await import("./src/core/search.js");
    const r = search.query("valve");
    check("BM25 search", r.total > 0, "hits=" + r.total);
  } catch (e) { check("search", false, e.message); }

  try {
    const ev = await import("./src/core/events.js");
    const pre = d.eventLog.length;
    ev.ingest({ event_type: "test", payload: {}, dedupe_key: "st:" + Date.now() }, { source: "selftest", source_type: "rest" });
    check("event pipeline ingest", d.eventLog.length > pre);
  } catch (e) { check("events", false, e.message); }

  console.table(results);
  return results;
};
