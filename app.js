// FORGE — bootstrap. Wires seed → store → router → shell → screens.

import { buildSeed } from "./src/data/seed.js";
import { state, initState, subscribe } from "./src/core/store.js";
import { defineRoute, startRouter, rerenderCurrent } from "./src/core/router.js";
import { openPalette } from "./src/core/palette.js";

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
  initState(buildSeed());
  applyTheme();
  setupRoutes();
  attachHotkeys();

  subscribe(() => {
    applyTheme();
    renderShell();
    rerenderCurrent();
  });

  startRouter();
  renderShell();
}

boot();

// Light sanity checks (console only; no-ops for production).
window.__forgeSelfTest = function () {
  const d = state.data;
  console.assert(d.documents.length >= 3, "documents seeded");
  console.assert(d.revisions.length >= 4, "revisions seeded");
  console.assert(d.incidents.length >= 1, "incidents seeded");
  console.assert(d.workItems.length >= 5, "work items seeded");
  console.log("FORGE self-test OK", {
    docs: d.documents.length,
    revisions: d.revisions.length,
    incidents: d.incidents.length,
    workItems: d.workItems.length,
  });
};
