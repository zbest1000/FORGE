// FORGE — bootstrap. Wires seed → store → router → shell → screens.

import { buildSeed } from "./src/data/seed.js";
import { state, update, initState, subscribe, registerAuditImpl } from "./src/core/store.js";
import { defineRoute, startRouter, rerenderCurrent, onRouteChange } from "./src/core/router.js";
import { openPalette } from "./src/core/palette.js";
import { initI3X } from "./src/core/i3x/client.js";
import { normalizeSeed } from "./src/core/normalize.js";
// Audit + search are critical-path modules (audit fires on every store
// mutation, search rebuilds index on every state change). Statically
// imported so Vite chunks them into the entry bundle. The previous mix
// of static + dynamic imports hit Vite's `INEFFECTIVE_DYNAMIC_IMPORT`
// warning and prevented chunk separation; now they're consistently
// static and the self-test below uses the same in-scope references.
// `auditMod` is the namespace import — the store wires the audit impl
// at boot via registerAuditImpl(auditMod) so audit() can be called
// from anywhere without circular store→audit→store imports.
import * as auditMod from "./src/core/audit.js";
import { initAuditLedger, audit, verifyLedger, exportAuditPack, verifyAuditPack } from "./src/core/audit.js";
import { buildIndex, scheduleRebuild, query as searchQuery } from "./src/core/search.js";
import { installHotkeys } from "./src/core/hotkeys.js";
import { probe, mode, getToken, login, logout, api } from "./src/core/api.js";
import { canAccessRoute, currentUserId, effectiveGroupIds, currentUser, requiredGroupsForRoute } from "./src/core/groups.js";
import { el, mount, installRowKeyboardHandlers, toast } from "./src/core/ui.js";
import { loadLicense, onLicenseChange } from "./src/core/license.js";
import { logger } from "./src/core/logging.js";

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
// docViewer is lazy — it pulls in PDF.js, marked, dompurify, and the
// revision compare diff. Most landing routes don't need any of that.
import { renderApprovals } from "./src/screens/approvals.js";
// admin, integrations, operations, and the doc viewer pair are lazy-loaded
// so they don't bloat the eager bundle. They're heavy screens (admin alone
// is ~100 KB minified), and most users hit /home or /hub first without ever
// going to admin.

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
        logger.error("lazy.missing-export", { exportName, label });
        return;
      }
      fn(params);
    }).catch((err) => {
      logger.error("lazy.load-failed", { label, err: err?.message || String(err) });
      // A failed dynamic import on a hashed chunk filename almost
      // always means the build was redeployed under us — the URL
      // referenced by the loaded entry chunk no longer exists in
      // /assets/. Treat this as "stale tab" rather than a generic
      // network error, and offer a one-click reload.
      const msg = String(err?.message || err || "");
      const isStaleChunk =
        /Failed to fetch dynamically imported module/i.test(msg) ||
        /\bimport\(\)\b.*failed/i.test(msg) ||
        /ChunkLoadError/i.test(msg) ||
        /Loading chunk \d+ failed/i.test(msg) ||
        /Importing a module script failed/i.test(msg);
      if (root) {
        mount(root, [
          el("div", { class: "stack", style: { padding: "24px", "max-width": "640px", margin: "32px auto", gap: "12px" } }, [
            el("div", { class: "callout " + (isStaleChunk ? "warn" : "danger") }, [
              isStaleChunk
                ? "A newer version of FORGE is available. Reload to continue."
                : `Failed to load the ${label} screen. Check your network connection and try again.`,
            ]),
            el("div", { class: "row", style: { gap: "8px" } }, [
              el("button", {
                class: "btn primary",
                onClick: () => { try { location.reload(); } catch { /* no-op */ } },
              }, [isStaleChunk ? "Reload now" : "Retry"]),
              !isStaleChunk
                ? el("button", { class: "btn", onClick: () => { try { location.reload(); } catch {} } }, ["Reload page"])
                : null,
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
  defineRoute("/work",
    lazy(() => import("./src/screens/allWork.js"), "renderAllWork", "All work"));

  defineRoute("/docs",
    lazy(() => import("./src/screens/docViewer.js"), "renderDocsIndex", "Documents"));
  defineRoute("/doc/:id",
    lazy(() => import("./src/screens/docViewer.js"), "renderDocViewer", "Document"));
  defineRoute("/edit/:id",
    lazy(() => import("./src/screens/edit.js"), "renderEdit", "Editor"));
  defineRoute("/compare/:left/:right",
    lazy(() => import("./src/screens/revisionCompare.js"), "renderRevisionCompare", "Revision Compare"));

  // Drawings → pulls in pdfjs, web-ifc, three, online-3d-viewer, dxf-viewer
  defineRoute("/drawings",
    lazy(() => import("./src/screens/drawingViewer.js"), "renderDrawingsIndex", "Drawings"));
  defineRoute("/drawing/:id",
    lazy(() => import("./src/screens/drawingViewer.js"), "renderDrawingViewer", "Drawing viewer"));

  defineRoute("/assets",
    lazy(() => import("./src/screens/assetDashboard.js"), "renderAssetDashboard", "Asset dashboard"));
  // The legacy table view stays reachable for power users while the
  // dashboard is in phase 1. New routes for nested chains land in
  // later phases (Profiles admin → /profiles, etc.).
  defineRoute("/admin/assets",
    lazy(() => import("./src/screens/assetDetail.js"), "renderAssetsIndex", "Assets (table)"));
  defineRoute("/asset/:id",
    lazy(() => import("./src/screens/assetDetail.js"), "renderAssetDetail", "Asset"));

  defineRoute("/incidents",
    lazy(() => import("./src/screens/incident.js"), "renderIncidentsIndex", "Incidents"));
  defineRoute("/incident/:id",
    lazy(() => import("./src/screens/incident.js"), "renderIncident", "Incident"));

  defineRoute("/approvals", renderApprovals);
  defineRoute("/operations",
    lazy(() => import("./src/screens/operations.js"), "renderOperationsData", "Operations Data"));
  defineRoute("/ai",
    lazy(() => import("./src/screens/ai.js"), "renderAI", "AI Workspace"));

  defineRoute("/integrations",
    lazy(() => import("./src/screens/integrations.js"), "renderIntegrations", "Integrations"));
  defineRoute("/integrations/mqtt",
    lazy(() => import("./src/screens/mqtt.js"), "renderMQTT", "MQTT"));
  defineRoute("/integrations/opcua",
    lazy(() => import("./src/screens/opcua.js"), "renderOPCUA", "OPC UA"));
  defineRoute("/integrations/erp",
    lazy(() => import("./src/screens/erp.js"), "renderERP", "ERP"));

  defineRoute("/dashboards",
    lazy(() => import("./src/screens/dashboards.js"), "renderDashboards", "Dashboards"));
  defineRoute("/admin",
    lazy(() => import("./src/screens/admin.js"), "renderAdmin", "Admin"));
  defineRoute("/admin/:section",
    lazy(() => import("./src/screens/admin.js"), "renderAdmin", "Admin"));
  defineRoute("/audit",
    lazy(() => import("./src/screens/audit.js"), "renderAudit", "Audit"));
  defineRoute("/help",
    lazy(() => import("./src/screens/helpSite.js"), "renderHelpSite", "Documentation"));

  defineRoute("/spec",
    lazy(() => import("./src/screens/spec.js"), "renderSpec", "Spec Reference"));

  defineRoute("/profiles",
    lazy(() => import("./src/screens/profilesAdmin.js"), "renderProfilesAdmin", "Asset profiles"));

  defineRoute("/uns",
    lazy(() => import("./src/screens/uns.js"), "renderUNSIndex", "Unified Namespace"));
  defineRoute("/i3x",
    lazy(() => import("./src/screens/i3x.js"), "renderI3X", "i3X API Workbench"));
}

function applyTheme() {
  const themeName = state.ui.theme === "dark" ? "theme-dark" : "theme-light";
  const cls = [themeName];
  if (state.ui.focusMode) cls.push("focus-mode");
  if (!state.ui.showLeftPanel) cls.push("hide-left-panel");
  if (!state.ui.showContextPanel) cls.push("hide-right-panel", "hide-context-panel");
  if (!state.ui.showRail) cls.push("hide-rail");
  if (!state.ui.showHeader) cls.push("hide-header");
  if (!state.ui.dockVisible) cls.push("dock-hidden");
  if (state.ui.portalId) cls.push("portal-mode", "portal-" + state.ui.portalId);
  document.body.className = cls.join(" ");
  // UX-A: keep the html element's theme class + native colour-scheme
  // hint in lockstep with the body's. The pre-paint script in
  // `index.html` seeds these; we re-apply on every render so user
  // toggles (View ▾ → Toggle theme, header rail icon) flow through
  // to native form controls and the browser scrollbar gutter.
  const de = document.documentElement;
  de.classList.remove("theme-dark", "theme-light");
  de.classList.add(themeName);
  de.style.colorScheme = state.ui.theme === "dark" ? "dark" : "light";
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
      // store is statically imported; no dynamic-load round trip needed.
      update(s => {
        s.ui.showRail = true; s.ui.showLeftPanel = true; s.ui.showContextPanel = true;
        s.ui.showHeader = true; s.ui.focusMode = false; s.ui.dockVisible = true;
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
  // Health probe also stays unawaited — the shell can render in offline /
  // demo mode and the connection state will fall in once /api/health
  // resolves a few hundred ms later.
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

  // Coalesce re-renders to one per animation frame. A burst of updates (e.g.
  // typing in an input that mutates state on each keystroke, or a server
  // response that updates several collections at once) used to fire
  // renderShell + rerenderCurrent + scheduleRebuild N times. Now they run
  // at most once per frame. scheduleRebuild() itself debounces 250 ms, so
  // calling it on every UI-only change is wasted work but not harmful.
  let _renderScheduled = false;
  subscribe(() => {
    if (_renderScheduled) return;
    _renderScheduled = true;
    requestAnimationFrame(() => {
      _renderScheduled = false;
      applyTheme();
      renderShell();
      rerenderCurrent();
      scheduleRebuild();
    });
  });

  // Refresh the UNS live-value card on a slow cadence so VQT updates show
  // through. We used to call `rerenderCurrent()` here, which replaced the
  // entire screen DOM every 1.5s — that reset scroll position, focus, and
  // tree expand-state, making the page unusable while values ticked. The
  // surgical alternative imports lazily so the bundle for `/uns` stays
  // out of the entry chunk.
  //
  // The i3X explorer is NOT auto-refreshed because the user edits request
  // bodies there and we must not wipe input focus.
  setInterval(() => {
    if (!(state.route || "").startsWith("/uns")) return;
    // Skip when a modal/palette is open or the user is interacting.
    if (document.querySelector(".modal-backdrop, .palette-backdrop")) return;
    const ae = document.activeElement;
    if (ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || ae.tagName === "SELECT")) return;
    import("./src/screens/uns.js").then(mod => {
      if (typeof mod.refreshUNSLive === "function") mod.refreshUNSLive();
    }).catch(() => { /* if the module isn't loaded yet, the next tick will retry */ });
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
    logger.info("forge.server.connected", health);
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
        // Goes through logger.info → scrub() — emails are auto-redacted, only role shows.
        logger.info("forge.signed-in", { email: me.user.email, role: me.user.role });
      } catch {
        logger.warn("forge.token.rejected");
      }
    }
    renderShell();
  } else {
    state.server = { connected: false };
    logger.info("forge.mode.demo");
  }
}

/** @type {any} */ (window).forge = { mode, login, logout, api };

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
  // store + audit are statically imported above; the previous nested
  // dynamic import chain prevented Vite from separating audit.js into
  // its own chunk (INEFFECTIVE_DYNAMIC_IMPORT warning). Direct calls now.
  update(s => { (s.data.workItems = s.data.workItems || []).push(item); });
  audit("access.request", id, { route, required: requiredIds });
  toast(`Access request ${id} filed`, "success");
}

// Field mode (spec §12.5): register the service worker so the SPA shell is
// available offline and queued writes can be replayed when connectivity
// returns. Localhost-friendly: only registers when served over http(s).
if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost" || location.hostname === "127.0.0.1")) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").then(reg => {
      logger.info("forge.sw.registered", { scope: reg.scope });
      // Replay queue when we come back online.
      window.addEventListener("online", () => reg.active?.postMessage({ type: "replay-queue" }));
    }).catch(err => logger.warn("forge.sw.register-failed", { err: err?.message || String(err) }));

    navigator.serviceWorker.addEventListener("message", (e) => {
      const msg = e.data || {};
      if (msg.type === "offline-queued") logger.info("forge.offline.queued", { id: msg.id, url: msg.url });
      if (msg.type === "offline-replayed") logger.info("forge.offline.replayed", { id: msg.id, status: msg.status });
    });
  });
}

boot();

// Self-test suite (console only). Run `__forgeSelfTest()` in DevTools.
/** @type {any} */ (window).__forgeSelfTest = async function () {
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

  // Audit + search are statically imported at the top — using those
  // bindings instead of `await import(...)` keeps Vite's chunking
  // honest (no INEFFECTIVE_DYNAMIC_IMPORT split warning).
  try {
    const v = await verifyLedger();
    check("audit ledger intact", v.ok, `strict=${v.strictCount}`);
    const pack = await exportAuditPack();
    check("audit pack verifies", await verifyAuditPack(pack), `entries=${pack.entry_count}`);
  } catch (e) { check("audit module", false, e.message); }

  try {
    const r = searchQuery("valve");
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
