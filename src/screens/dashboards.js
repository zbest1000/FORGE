// Workspace dashboard surface — uses the configurable canvas to host
// any number of named dashboards scoped to the workspace (default
// "Workspace overview"). Operators with `edit` capability can toggle
// edit mode + add / move / resize / delete panels.

import { el, mount, toast, modal, formRow, input, confirm } from "../core/ui.js";
import { state, update } from "../core/store.js";
import { audit } from "../core/audit.js";
import { can } from "../core/permissions.js";
import { renderDashboard, getOrCreateDashboard } from "../core/dashboardCanvas.js";
import { helpHint, helpLinkChip } from "../core/help.js";

const SS_ACTIVE = "dashboards.active";

export function renderDashboards() {
  const root = document.getElementById("screenContainer");
  // Ensure at least one workspace dashboard exists so the screen is
  // never empty on first visit.
  getOrCreateDashboard("workspace", "Workspace overview");
  const list = (state.data?.dashboards || []).filter(ds => ds.scope === "workspace" || !(typeof ds.scope === "string" && ds.scope.startsWith("asset:")));
  const activeId = sessionStorage.getItem(SS_ACTIVE) || list[0]?.id;
  const active = list.find(ds => ds.id === activeId) || list[0];

  const canvasHost = el("div", { class: "dashboard-canvas-host" });
  if (active) renderDashboard(canvasHost, active.scope, { name: active.name });

  mount(root, [
    el("div", { class: "row spread mb-3" }, [
      el("div", {}, [
        el("h2", { style: { margin: 0, display: "inline-flex", alignItems: "center" } }, [
          "Dashboards", helpHint("forge.operations"),
        ]),
        el("div", { class: "tiny muted" }, [
          "Configurable workspace dashboards — drag the panel header to move, the bottom-right corner to resize, click ⚙ on a panel to rename.",
        ]),
        el("div", { class: "row wrap", style: { gap: "6px", marginTop: "6px" } }, [
          helpLinkChip("forge.operations", "Live VQT model"),
          helpLinkChip("forge.audit-chain", "Audit chain"),
        ]),
      ]),
      el("div", { class: "row wrap" }, [
        ...list.map(ds => el("button", {
          class: `btn sm ${ds.id === active?.id ? "primary" : ""}`,
          onClick: () => { sessionStorage.setItem(SS_ACTIVE, ds.id); renderDashboards(); },
        }, [ds.name])),
        el("button", { class: "btn sm ghost", disabled: !can("edit"), onClick: () => createDashboard() }, ["+ New dashboard"]),
        active ? el("button", { class: "btn sm ghost", disabled: !can("edit"), onClick: () => renameDashboard(active) }, ["Rename"]) : null,
        active ? el("button", { class: "btn sm danger", disabled: !can("edit"), onClick: () => deleteDashboard(active) }, ["Delete"]) : null,
      ]),
    ]),
    canvasHost,
  ]);
}

function createDashboard() {
  if (!can("edit")) { toast("Requires edit capability", "warn"); return; }
  const nameInput = input({ value: "New dashboard" });
  modal({
    title: "New dashboard",
    body: formRow("Name", nameInput),
    actions: [
      { label: "Cancel" },
      { label: "Create", variant: "primary", onClick: () => {
        const id = "DSH-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6).toUpperCase();
        const dash = {
          id,
          name: /** @type {HTMLInputElement} */ (nameInput).value || "Dashboard",
          scope: "workspace",
          panels: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        update(s => {
          /** @type {any} */ (s.data).dashboards = /** @type {any} */ (s.data).dashboards || [];
          /** @type {any} */ (s.data).dashboards.push(dash);
        });
        audit("dashboard.create", id, { name: dash.name });
        sessionStorage.setItem(SS_ACTIVE, id);
        renderDashboards();
      }},
    ],
  });
}

function renameDashboard(ds) {
  const nameInput = input({ value: ds.name });
  modal({
    title: "Rename dashboard",
    body: formRow("Name", nameInput),
    actions: [
      { label: "Cancel" },
      { label: "Save", variant: "primary", onClick: () => {
        update(s => {
          const target = (/** @type {any} */ (s.data).dashboards || []).find(x => x.id === ds.id);
          if (target) target.name = /** @type {HTMLInputElement} */ (nameInput).value || target.name;
        });
        audit("dashboard.rename", ds.id);
        renderDashboards();
      }},
    ],
  });
}

async function deleteDashboard(ds) {
  if (!await confirm({ title: "Delete dashboard", message: `Delete ${ds.name}?`, variant: "danger" })) return;
  update(s => {
    /** @type {any} */ (s.data).dashboards = (/** @type {any} */ (s.data).dashboards || []).filter(x => x.id !== ds.id);
  });
  audit("dashboard.delete", ds.id);
  sessionStorage.removeItem(SS_ACTIVE);
  renderDashboards();
}
