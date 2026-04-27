// FORGE — bootstrap. Wires seed → store → router → shell → screens.

import { buildSeed } from "./src/data/seed.js";
import { state, initState, subscribe, registerAuditImpl } from "./src/core/store.js";
import { defineRoute, startRouter, rerenderCurrent, onRouteChange } from "./src/core/router.js";
import { openPalette } from "./src/core/palette.js";
import { initI3X } from "./src/core/i3x/client.js";
import { normalizeSeed } from "./src/core/normalize.js";
import * as auditMod from "./src/core/audit.js";
import { initAuditLedger } from "./src/core/audit.js";
import { buildIndex, scheduleRebuild } from "./src/core/search.js";
import { installHotkeys } from "./src/core/hotkeys.js";
import { probe, mode, getToken, login, logout, api } from "./src/core/api.js";
import { canAccessRoute, requiredGroupsForRoute, effectiveGroupIds, currentUserId, currentUser } from "./src/core/groups.js";
import { loadLicense, onLicenseChange } from "./src/core/license.js";
import { el, mount, toast } from "./src/core/ui.js";

import { renderRail } from "./src/shell/rail.js";
import { renderLeftPanel } from "./src/shell/leftPanel.js";
import { renderHeader } from "./src/shell/header.js";
import { renderContextPanel } from "./src/shell/contextPanel.js";
import { renderDock } from "./src/shell/dock.js";

// Light, frequently-visited screens stay statically imported so the
// initial bundle has them ready without an extra round-trip.
import { renderHome } from "./src/screens/home.js";
import { renderHub } from "./src/screens/hub.js";
import { renderInbox } from "./src/screens/inbox.js";
import { renderSearch } from "./src/screens/search.js";
import { renderTeamSpacesIndex, renderTeamSpace } from "./src/screens/teamSpaces.js";
import { renderChannel } from "./src/screens/channel.js";
import { renderProjectsIndex, renderWorkBoard } from "./src/screens/workBoard.js";
import { renderDocsIndex, renderDocViewer } from "./src/screens/docViewer.js";
import { renderApprovals } from "./src/screens/approvals.js";
import { renderIntegrations } from "./src/screens/integrations.js";
import { renderOperationsData } from "./src/screens/operations.js";
import { renderAdmin } from "./src/screens/admin.js";

// Heavy / specialist screens are lazy-loaded the first time the user
// navigates to them. This keeps the initial bundle small — the WebGL,
// WebAssembly and PDF runtimes only land when needed.
function lazy(loader, exportName, label) {
  return (params) => {
    const root = document.getElementById("screenContainer");
    if (root) {
      mount(root, [
        el("div", { class: "stack", style: { padding: "24px", "max-width": "640px", margin: "32px auto" } }, [
          el("div", { class: "tiny muted" }, [`Loading ${label}…`]),
        ]),
      ]);
    }
    loader().then((mod) => {
      const fn = mod[exportName];
      if (typeof fn !== "function") {
        console.error(`[lazy] missing export ${exportName} in ${label}`);
        return;
      }
      fn(params);
    }).catch((err) => {
      console.error(`[lazy] failed to load ${label}`, err);
      if (root) {
        mount(root, [
          el("div", { class: "stack", style: { padding: "24px" } }, [
            el("div", { class: "callout danger" }, [
              `Failed to load the ${label} screen. Check your network connection and try again.`,
            ]),
            el("div", { class: "tiny muted" }, [String(err?.message || err)]),
          ]),
        ]);
      }
    });
  };
}

function setupRoutes() {
  defineRoute("/hub", renderHub);
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
  defineRoute("/compare/:left/:right",
    lazy(() => import("./src/screens/revisionCompare.js"), "renderRevisionCompare", "Revision Compare"));

  // Drawings → pulls in pdfjs, web-ifc, three, online-3d-viewer, dxf-viewer
  defineRoute("/drawings",
    lazy(() => import("./src/screens/drawingViewer.js"), "renderDrawingsIndex", "Drawings"));
  defineRoute("/drawing/:id",
    lazy(() => import("./src/screens/drawingViewer.js"), "renderDrawingViewer", "Drawing viewer"));

  defineRoute("/assets",
    lazy(() => import("./src/screens/assetDetail.js"), "renderAssetsIndex", "Assets"));
  defineRoute("/asset/:id",
    lazy(() => import("./src/screens/assetDetail.js"), "renderAssetDetail", "Asset"));

  defineRoute("/incidents",
    lazy(() => import("./src/screens/incident.js"), "renderIncidentsIndex", "Incidents"));
  defineRoute("/incident/:id",
    lazy(() => import("./src/screens/incident.js"), "renderIncident", "Incident"));

  defineRoute("/approvals", renderApprovals);
  defineRoute("/operations", renderOperationsData);
  defineRoute("/ai",
    lazy(() => import("./src/screens/ai.js"), "renderAI", "AI Workspace"));

  defineRoute("/integrations", renderIntegrations);
  defineRoute("/integrations/mqtt",
    lazy(() => import("./src/screens/mqtt.js"), "renderMQTT", "MQTT"));
  defineRoute("/integrations/opcua",
    lazy(() => import("./src/screens/opcua.js"), "renderOPCUA", "OPC UA"));
  defineRoute("/integrations/erp",
    lazy(() => import("./src/screens/erp.js"), "renderERP", "ERP"));

  defineRoute("/dashboards",
    lazy(() => import("./src/screens/dashboards.js"), "renderDashboards", "Dashboards"));
  defineRoute("/admin", renderAdmin);
  defineRoute("/admin/:section", renderAdmin);
  defineRoute("/spec",
    lazy(() => import("./src/screens/spec.js"), "renderSpec", "Spec Reference"));

  defineRoute("/uns",
    lazy(() => import("./src/screens/uns.js"), "renderUNSIndex", "Unified Namespace"));
  defineRoute("/i3x",
    lazy(() => import("./src/screens/i3x.js"), "renderI3X", "i3X API Workbench"));
}

function applyTheme() {
  const cls = [state.ui.theme === "dark" ? "theme-dark" : "theme-light"];
  if (state.ui.focusMode) cls.push("focus-mode");
  if (!state.ui.showLeftPanel) cls.push("hide-left-panel");
  if (!state.ui.showContextPanel) cls.push("hide-right-panel", "hide-context-panel");
  if (!state.ui.showRail) cls.push("hide-rail");
  if (!state.ui.showHeader) cls.push("hide-header");
  if (state.ui.fieldMode) cls.push("field-mode");
  if (state.ui.portalId) cls.push("portal-mode", "portal-" + state.ui.portalId);
  document.body.className = cls.join(" ");
}

// Routes where the right context panel adds enough value that we auto-open
// it on first navigation per session. Once a user manually toggles it via
// the header "Details" button, we respect their choice for the rest of
// the session.
const RICH_CONTEXT_ROUTES = [
  /^\/doc\//,
  /^\/drawing\//,
  /^\/asset\//,
  /^\/incident\//,
  /^\/work-board\//,
];

function maybeAutoOpenContextPanel() {
  const route = (state.route || "").split("?")[0];
  const rich = RICH_CONTEXT_ROUTES.some(r => r.test(route));
  if (!rich) return;
  if (sessionStorage.getItem("forge.contextPanelTouched") === "1") return;
  if (state.ui.showContextPanel) return;
  state.ui.showContextPanel = true;
}

function applyPortalFromUrl() {
  // Sync state.ui.portalId from `?portal=...` in the hash. Allows opening
  // any link with a portal scope and re-rendering the rail/header to match.
  try {
    const raw = location.hash.replace(/^#/, "");
    const q = raw.split("?")[1];
    const sp = q ? new URLSearchParams(q) : null;
    const id = sp ? sp.get("portal") : null;
    if (state.ui.portalId !== id) state.ui.portalId = id || null;
  } catch { /* noop */ }
}

function renderShell() {
  applyPortalFromUrl();
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
  // The floating "restore layout" button — only visible when chrome is hidden
  // (see styles.css). Restores all panels and the header in one click.
  const restoreBtn = document.getElementById("layoutRestore");
  if (restoreBtn) {
    restoreBtn.addEventListener("click", () => {
      import("./src/core/store.js").then(({ update }) => {
        update(s => {
          s.ui.showRail = true; s.ui.showLeftPanel = true; s.ui.showContextPanel = true;
          s.ui.showHeader = true; s.ui.focusMode = false; s.ui.dockVisible = true;
        });
      });
    });
  }
}

async function boot() {
  // Server probe happens in parallel with local state init so the shell
  // renders immediately in either mode. The client runs fully offline in
  // demo mode and talks to a real Fastify backend when served from it.
  const healthP = probe().catch(() => null);

  const seed = normalizeSeed(buildSeed());
  initState(seed);
  registerAuditImpl(auditMod);
  initAuditLedger();
  initI3X(state.data);

  // Kick off license fetch (server mode only). We don't await it here so
  // first paint is unblocked; screens that depend on entitlements wait
  // on `loadLicense()` themselves. License changes re-render the shell.
  await healthP;
  loadLicense();
  onLicenseChange(() => { renderShell(); rerenderCurrent(); });
  // Kick off index build; MiniSearch loads async, hand-rolled fallback is
  // used in the meantime for the first `query()` call.
  buildIndex();
  applyTheme();
  setupRoutes();
  attachHotkeys();
  installHotkeys();
  installRowKeyboardHandlers();

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

  // Route-level group gating — if a user navigates to a route their groups
  // don't grant access to (e.g. /admin without IT membership), show a polite
  // forbidden screen instead of the underlying content.
  onRouteChange(() => {
    // Sync layout chrome (rail/header) to the new route's portal id.
    maybeAutoOpenContextPanel();
    applyTheme();
    renderShell();

    const route = (state.route || "").split("?")[0];
    if (!canAccessRoute(route)) {
      // Record the denial in the audit ledger so a security reviewer can see
      // who attempted to reach what. Includes the user's effective groups
      // so the reviewer can act (grant access, revoke, etc.).
      try {
        audit("access.denied", route, {
          userId: currentUserId(),
          effectiveGroupIds: effectiveGroupIds(currentUserId()),
        });
      } catch { /* ledger may not be ready during boot */ }
      const root = document.getElementById("screenContainer");
      if (root) {
        const required = requiredGroupsForRoute(route) || [];
        const groupsById = Object.fromEntries((state.data?.groups || []).map(g => [g.id, g]));
        const requiredLabels = required.map(id => groupsById[id]?.name || id);
        const me = currentUser();
        const myGroups = effectiveGroupIds(currentUserId());
        const myLabels = myGroups.length
          ? myGroups.map(id => groupsById[id]?.name || id).join(", ")
          : "(no groups)";
        mount(root, [
          el("div", { class: "forbidden" }, [
            el("h2", {}, ["Restricted area"]),
            el("p", { class: "muted" }, [
              "This route requires you to be a member of one of the groups below. ",
              "Ask your administrator to add you, or open a different portal from the Hub.",
            ]),
            el("dl", { class: "forbidden-detail" }, [
              el("dt", {}, ["Route"]),
              el("dd", {}, [route]),
              el("dt", {}, ["Required group(s) — any of"]),
              el("dd", {}, [requiredLabels.length ? requiredLabels.join(", ") : "—"]),
              el("dt", {}, ["Your effective groups"]),
              el("dd", {}, [myLabels]),
              el("dt", {}, ["Signed in as"]),
              el("dd", {}, [me ? `${me.name} · ${me.role || state.ui.role}` : (state.ui.role || "demo user")]),
            ]),
            el("div", { class: "row wrap", style: { justifyContent: "center" } }, [
              el("button", {
                class: "btn primary",
                onClick: () => requestAccess(route, required, requiredLabels),
              }, ["Request access"]),
              el("button", { class: "btn", onClick: () => location.hash = "#/hub" }, ["Go to Hub"]),
              el("button", { class: "btn ghost", onClick: () => history.back() }, ["Back"]),
            ]),
          ]),
        ]);
      }
    }
  });

  startRouter();
  renderShell();

  const health = await healthP;
  if (health) {
    state.server = { connected: true, health };
    console.info("[forge] connected to server", health);
    // If a token is cached, warm /api/me to populate the real user.
    if (getToken()) {
      try {
        const me = await api("/api/me");
        state.server.user = me.user;
        // Adopt the server user's role unless the user has already manually
        // overridden it via the header dropdown this session. Without this
        // sync, group/route gates can wrongly forbid an admin who signed in
        // through the server because state.ui.role still reflects the demo
        // seed default.
        if (me.user?.role && !state.ui.roleOverridden) {
          state.ui.role = me.user.role;
        }
        console.info("[forge] signed in as", me.user.email, "role=", me.user.role);
      } catch {
        console.warn("[forge] stored token rejected; staying anonymous");
      }
    }
    renderShell();
  } else {
    state.server = { connected: false };
    console.info("[forge] demo mode (no backend)");
  }
}

window.forge = { mode, login, logout, api };

function requestAccess(route, requiredIds, requiredLabels) {
  // Create a work item asking for access. Picks the first available project
  // so the request is trackable through the existing Approval/Work flows.
  const project = (state.data?.projects || [])[0];
  if (!project) {
    toast("Cannot file access request — no projects in this workspace.", "warn");
    return;
  }
  const me = currentUser();
  const id = "WI-AR-" + Math.floor(Math.random() * 9000 + 1000);
  const item = {
    id,
    projectId: project.id,
    type: "Action",
    title: `Access request — ${route}`,
    description: `User ${me?.name || state.ui.role} requests membership in one of: ${(requiredLabels || []).join(", ") || "(unspecified)"} to access ${route}.`,
    assigneeId: "U-1",
    status: "Open",
    severity: "low",
    due: null,
    blockers: [],
    labels: ["access-request", ...requiredIds],
    created_at: new Date().toISOString(),
  };
  import("./src/core/store.js").then(({ update }) => {
    update(s => { (s.data.workItems = s.data.workItems || []).push(item); });
    import("./src/core/audit.js").then(({ audit }) => {
      audit("access.request", id, { route, required: requiredIds });
    });
    toast(`Access request ${id} filed`, "success");
  });
}

// Field mode (spec §12.5): register the service worker so the SPA shell is
// available offline and queued writes can be replayed when connectivity
// returns. Localhost-friendly: only registers when served over http(s).
if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost" || location.hostname === "127.0.0.1")) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").then(reg => {
      console.info("[forge] service worker registered", reg.scope);
      // Replay queue when we come back online.
      window.addEventListener("online", () => reg.active?.postMessage({ type: "replay-queue" }));
    }).catch(err => console.warn("[forge] sw register failed", err));

    navigator.serviceWorker.addEventListener("message", (e) => {
      const msg = e.data || {};
      if (msg.type === "offline-queued") console.info("[forge] queued offline write", msg.id, msg.url);
      if (msg.type === "offline-replayed") console.info("[forge] replayed", msg.id, "status", msg.status);
    });
  });
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
