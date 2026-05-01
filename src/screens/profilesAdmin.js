// Asset Profiles admin screen.
//
// Phase 2 surface: list + create + version + archive + delete.
// Phase 3 will add the apply-profile flow on the asset Configuration
// tab and the free-form SQL toggle (gated behind `historian.sql.raw`).
//
// Demo mode (no server) renders the seeded profiles read-only so a
// sales / UX walkthrough still has something to show. Mutations are
// guarded by `requireServer()` and surface a clear toast otherwise.
//
// Layout: two-pane.
//   Left  — filterable profile list (annotated with version + binding
//           counts so operators see at a glance which profiles are in
//           production).
//   Right — version-aware editor: name/description metadata + the
//           latest version's source-template + points table. Version
//           history is one click away.
//
// Spec ref: docs/INDUSTRIAL_EDGE_PLATFORM_SPEC.md §4.3 — asset class
// schemas. The points list here is the manifestation of that contract.

import {
  el, mount, card, badge, kpi, toast, modal, formRow, input, textarea,
  select, prompt, confirm, tabs,
} from "../core/ui.js";
import { state } from "../core/store.js";
import { api } from "../core/api.js";
import { navigate } from "../core/router.js";

const SS_SELECTED = "profiles.admin.selected";
const SS_FILTER_KIND = "profiles.admin.filter.kind";

export async function renderProfilesAdmin() {
  const root = document.getElementById("screenContainer");
  if (!root) return;

  // Loading shell.
  mount(root, [renderShell({ profiles: [], loading: true })]);

  let profiles;
  let demo = false;
  if (state.server?.connected) {
    try {
      profiles = await api("/api/asset-profiles");
    } catch (err) {
      return mount(root, [
        card("Profiles", el("div", { class: "stack" }, [
          el("div", { class: "callout danger" }, [`Failed to load /api/asset-profiles: ${err?.message || err}`]),
          el("button", { class: "btn", onClick: renderProfilesAdmin }, ["Retry"]),
        ])),
      ]);
    }
  } else {
    profiles = (state.data?.assetProfiles || []).map(p => ({
      ...p,
      versionCount: (state.data?.assetProfileVersions || []).filter(v => v.profileId === p.id).length,
      bindingCount: (state.data?.assetPointBindings || []).filter(b => {
        const v = (state.data?.assetProfileVersions || []).find(vv => vv.id === b.profileVersionId);
        return v && v.profileId === p.id;
      }).length,
    }));
    demo = true;
  }

  mount(root, [renderShell({ profiles, demo })]);
}

function renderShell({ profiles, demo = false, loading = false }) {
  const kindFilter = sessionStorage.getItem(SS_FILTER_KIND) || "";
  const visible = kindFilter ? profiles.filter(p => p.sourceKind === kindFilter) : profiles;
  const selectedId = sessionStorage.getItem(SS_SELECTED) || visible[0]?.id || "";
  const selected = visible.find(p => p.id === selectedId) || visible[0] || null;

  return el("div", { class: "stack" }, [
    headerRow(profiles.length, demo, loading),
    el("div", { class: "two-col" }, [
      card("Profiles", listPanel(visible, selected?.id, kindFilter, demo), {
        actions: [el("button", { class: "btn sm primary", onClick: () => createProfilePrompt() }, ["+ New profile"])],
        subtitle: `${visible.length} of ${profiles.length} shown`,
      }),
      selected
        ? editorPanel(selected, demo)
        : card("Profile editor", el("div", { class: "muted" }, ["Select a profile, or click + New profile."])),
    ]),
  ]);
}

function headerRow(total, demo, loading) {
  return el("div", { class: "row spread", style: { marginBottom: "12px" } }, [
    el("div", {}, [
      el("div", { class: "strong" }, ["Asset profiles"]),
      el("div", { class: "tiny muted" }, [
        loading ? "Loading…" : `${total} profile${total === 1 ? "" : "s"} · versioned, immutable history, capability-gated`,
      ]),
    ]),
    el("div", { class: "row wrap" }, [
      demo
        ? badge("Demo mode · read-only", "warn", { title: "Sign in to a FORGE server to author profiles." })
        : badge("Live · server-backed", "success"),
      el("button", { class: "btn sm", onClick: renderProfilesAdmin }, ["Refresh"]),
    ]),
  ]);
}

function listPanel(profiles, selectedId, kindFilter, demo) {
  const kindOptions = [
    { value: "", label: "All sources" },
    { value: "mqtt", label: "MQTT" },
    { value: "opcua", label: "OPC UA" },
    { value: "sql", label: "SQL" },
  ];
  const kindSelect = select(kindOptions, {
    value: kindFilter,
    onChange: (e) => {
      sessionStorage.setItem(SS_FILTER_KIND, e.target.value);
      renderProfilesAdmin();
    },
  });

  if (!profiles.length) {
    return el("div", { class: "stack" }, [
      kindSelect,
      el("div", { class: "muted", style: { padding: "16px" } }, [
        demo
          ? "No profiles in the demo seed for this filter."
          : "No profiles yet. Click + New profile to define a reusable data schema (e.g. \"Centrifugal Pump\")."
      ]),
    ]);
  }

  return el("div", { class: "stack" }, [
    kindSelect,
    el("div", { class: "stack", style: { gap: "2px", maxHeight: "560px", overflowY: "auto" } },
      profiles.map(p => el("button", {
        type: "button",
        class: `tree-item ${p.id === selectedId ? "active" : ""}`,
        onClick: () => { sessionStorage.setItem(SS_SELECTED, p.id); renderProfilesAdmin(); },
      }, [
        el("span", { class: "tree-dot" }),
        el("div", { class: "stack", style: { flex: 1, gap: "1px", textAlign: "left" } }, [
          el("div", { class: "row", style: { gap: "8px" } }, [
            el("strong", {}, [p.name]),
            sourceKindBadge(p.sourceKind),
            statusBadge(p.status),
          ]),
          el("div", { class: "tiny muted" }, [
            `v${p.versionCount} · ${p.bindingCount} binding${p.bindingCount === 1 ? "" : "s"}`,
          ]),
        ]),
      ]))
    ),
  ]);
}

function sourceKindBadge(kind) {
  const variant = kind === "mqtt" ? "info" : kind === "opcua" ? "purple" : kind === "sql" ? "warn" : "";
  return badge(kind || "—", variant);
}

function statusBadge(status) {
  const variant = status === "active" ? "success" : status === "draft" ? "info" : status === "archived" ? "" : "";
  return badge(status || "—", variant);
}

// ---------- Editor panel ---------------------------------------------------

function editorPanel(profile, demo) {
  const tabKey = `profiles.editor.${profile.id}`;
  return card(profile.name, el("div", { class: "stack" }, [
    el("div", { class: "row wrap", style: { gap: "8px" } }, [
      sourceKindBadge(profile.sourceKind),
      statusBadge(profile.status),
      badge(`v${profile.versionCount}`, "info"),
      badge(`${profile.bindingCount} binding${profile.bindingCount === 1 ? "" : "s"}`, profile.bindingCount > 0 ? "accent" : ""),
      profile.workspaceId === null ? badge("library", "purple", { title: "Visible to all workspaces in the org." }) : null,
    ]),
    profile.description ? el("p", { class: "muted" }, [profile.description]) : null,
    tabs({
      sessionKey: tabKey,
      defaultId: "latest",
      ariaLabel: "Profile editor",
      tabs: [
        { id: "latest",   label: "Latest version", content: () => latestVersionTab(profile, demo) },
        { id: "history",  label: "Version history", content: () => versionHistoryTab(profile, demo) },
        { id: "metadata", label: "Metadata",        content: () => metadataTab(profile, demo) },
        { id: "danger",   label: "Danger",          content: () => dangerTab(profile, demo) },
      ],
    }),
  ]));
}

function latestVersionTab(profile, demo) {
  if (!state.server?.connected) {
    // Demo mode: show seed.
    const v = (state.data?.assetProfileVersions || []).find(vv => vv.id === profile.latestVersionId);
    if (!v) return el("div", { class: "muted" }, ["No version found."]);
    const points = (state.data?.assetProfilePoints || []).filter(p => p.profileVersionId === v.id);
    return versionDetail({ version: v, points, demo: true });
  }
  // Live mode: fetch detail.
  const wrap = el("div", { class: "stack" }, [el("div", { class: "muted tiny" }, ["Loading…"])]);
  api(`/api/asset-profiles/${profile.id}`).then((full) => {
    if (!full.latestVersion) {
      wrap.innerHTML = "";
      wrap.append(el("div", { class: "muted" }, ["No version yet."]));
      return;
    }
    wrap.innerHTML = "";
    wrap.append(versionDetail({ version: full.latestVersion, points: full.points, demo }));
    wrap.append(el("div", { class: "row wrap", style: { marginTop: "12px" } }, [
      el("button", { class: "btn primary", onClick: () => createVersionPrompt(profile, full.latestVersion, full.points) }, ["+ New version"]),
    ]));
  }).catch((err) => {
    wrap.innerHTML = "";
    wrap.append(el("div", { class: "callout danger" }, [`Failed: ${err?.message || err}`]));
  });
  return wrap;
}

function versionDetail({ version, points, demo }) {
  return el("div", { class: "stack" }, [
    el("div", { class: "row wrap" }, [
      badge(`v${version.version}`, "info"),
      statusBadge(version.status),
      el("span", { class: "tiny muted" }, [version.notes || "(no notes)"]),
    ]),
    el("div", { class: "stack", style: { gap: "4px" } }, [
      el("div", { class: "tiny muted" }, ["source_template (per source-kind config)"]),
      el("pre", { class: "mono", style: { whiteSpace: "pre-wrap", padding: "8px", borderRadius: "6px", background: "rgba(255,255,255,0.04)" } },
        [JSON.stringify(version.sourceTemplate, null, 2)]),
    ]),
    el("div", { class: "stack", style: { gap: "4px" } }, [
      el("div", { class: "tiny muted" }, [`Data points (${points.length})`]),
      el("table", { class: "table" }, [
        el("thead", {}, [el("tr", {}, ["Name", "Unit", "Type", "Source path template"].map(h => el("th", {}, [h])))]),
        el("tbody", {}, points.length
          ? points.map(p => el("tr", {}, [
              el("td", {}, [el("strong", {}, [p.name])]),
              el("td", {}, [p.unit || "—"]),
              el("td", {}, [p.dataType]),
              el("td", { class: "mono tiny" }, [p.sourcePathTemplate || "—"]),
            ]))
          : [el("tr", {}, [el("td", { colspan: "4", class: "muted" }, ["No points."])])]
        ),
      ]),
    ]),
  ]);
}

function versionHistoryTab(profile, demo) {
  if (!state.server?.connected) {
    const versions = (state.data?.assetProfileVersions || [])
      .filter(v => v.profileId === profile.id)
      .sort((a, b) => b.version - a.version);
    return versionsTable(versions, profile);
  }
  const wrap = el("div", { class: "stack" }, [el("div", { class: "muted tiny" }, ["Loading…"])]);
  api(`/api/asset-profiles/${profile.id}/versions`).then((rows) => {
    wrap.innerHTML = "";
    wrap.append(versionsTable(rows, profile));
  }).catch((err) => {
    wrap.innerHTML = "";
    wrap.append(el("div", { class: "callout danger" }, [`Failed: ${err?.message || err}`]));
  });
  return wrap;
}

function versionsTable(versions, profile) {
  if (!versions.length) return el("div", { class: "muted" }, ["No versions."]);
  return el("table", { class: "table" }, [
    el("thead", {}, [el("tr", {}, ["Version", "Status", "Points", "Bindings", "Created", "Notes"].map(h => el("th", {}, [h])))]),
    el("tbody", {}, versions.map(v => el("tr", {}, [
      el("td", {}, [el("strong", {}, [`v${v.version}`])]),
      el("td", {}, [statusBadge(v.status)]),
      el("td", {}, [String(v.pointCount ?? "—")]),
      el("td", {}, [String(v.bindingCount ?? "—")]),
      el("td", { class: "tiny muted" }, [v.createdAt ? new Date(v.createdAt).toLocaleString() : "—"]),
      el("td", { class: "tiny muted" }, [v.notes || ""]),
    ]))),
  ]);
}

function metadataTab(profile, demo) {
  return el("div", { class: "stack" }, [
    el("div", { class: "stack", style: { gap: "4px" } }, [
      el("div", { class: "tiny muted" }, ["Profile id"]),
      el("code", { class: "mono" }, [profile.id]),
    ]),
    el("div", { class: "stack", style: { gap: "4px" } }, [
      el("div", { class: "tiny muted" }, ["Source kind (immutable across versions)"]),
      el("code", { class: "mono" }, [profile.sourceKind]),
    ]),
    el("div", { class: "stack", style: { gap: "4px" } }, [
      el("div", { class: "tiny muted" }, ["Scope"]),
      el("code", { class: "mono" }, [profile.workspaceId === null ? "library (org-wide)" : `workspace ${profile.workspaceId}`]),
    ]),
    el("div", { class: "row wrap" }, [
      el("button", { class: "btn", onClick: () => editMetadataPrompt(profile) }, ["Edit name / description"]),
      profile.status === "active"
        ? el("button", { class: "btn", onClick: () => archive(profile) }, ["Archive"])
        : profile.status === "archived"
          ? el("button", { class: "btn", onClick: () => unarchive(profile) }, ["Reactivate"])
          : null,
    ]),
  ]);
}

function dangerTab(profile, demo) {
  return el("div", { class: "stack" }, [
    el("div", { class: "callout warn" }, [
      "Deleting a profile is refused while bindings reference any of its versions. ",
      "If bindings exist, archive the profile via the Metadata tab — that prevents new bindings without disrupting live ones.",
    ]),
    el("div", { class: "row wrap" }, [
      el("button", { class: "btn danger", onClick: () => deleteProfile(profile) }, ["Delete profile"]),
    ]),
  ]);
}

// ---------- Mutations ------------------------------------------------------

function requireServer(action) {
  if (state.server?.connected) return true;
  toast(`Demo mode is read-only — sign in to a FORGE server to ${action}.`, "warn");
  return false;
}

async function createProfilePrompt() {
  if (!requireServer("create profiles")) return;
  let name = "";
  let description = "";
  let sourceKind = "mqtt";
  let workspaceId = ""; // empty → library
  let pointsRaw = "temperature, C\npressure, bar\nvibration, mm/s";

  const nameInput = input({ placeholder: "e.g. Centrifugal Pump" });
  const descInput = textarea({ placeholder: "Short description / context (optional)", rows: 2 });
  const kindSelect = select([
    { value: "mqtt", label: "MQTT" },
    { value: "opcua", label: "OPC UA" },
    { value: "sql", label: "SQL" },
  ], { value: "mqtt" });
  const wsInput = input({ placeholder: "(blank = library / org-wide)", value: "" });
  const pointsArea = textarea({ rows: 6, value: pointsRaw, placeholder: "name, unit\nname, unit\n..." });
  const tplArea = textarea({ rows: 4, placeholder: "Optional JSON. Defaults to a sensible per-source-kind template.", value: '{ "topic_template": "forge/{enterprise}/{site}/{asset}/{point}", "qos": 1 }' });

  modal({
    title: "New profile",
    body: el("div", { class: "stack" }, [
      formRow("Name", nameInput),
      formRow("Description", descInput),
      formRow("Source kind", kindSelect),
      formRow("Workspace id (blank = library)", wsInput),
      formRow("Points (one per line: name, unit)", pointsArea),
      formRow("source_template JSON", tplArea),
    ]),
    actions: [
      { label: "Cancel" },
      { label: "Create", variant: "primary", onClick: async () => {
        const points = pointsArea.value.split("\n").map(line => {
          const [n, u] = line.split(",").map(s => s.trim());
          if (!n) return null;
          return { name: n, unit: u || null, dataType: "number", sourcePathTemplate: kindSelect.value === "opcua"
            ? `{enterprise}.{site}.{asset}.${n}`
            : `{enterprise}/{site}/{asset}/${n}` };
        }).filter(Boolean);
        if (!nameInput.value.trim()) { toast("Name required", "warn"); return false; }
        if (!points.length) { toast("Add at least one point", "warn"); return false; }
        let sourceTemplate = {};
        try { sourceTemplate = JSON.parse(tplArea.value || "{}"); }
        catch { toast("source_template must be valid JSON", "warn"); return false; }
        try {
          await api("/api/asset-profiles", { method: "POST", body: {
            name: nameInput.value.trim(),
            description: descInput.value.trim() || null,
            sourceKind: kindSelect.value,
            workspaceId: wsInput.value.trim() || null,
            sourceTemplate,
            points,
          }});
          toast("Profile created", "success");
          renderProfilesAdmin();
        } catch (err) {
          toast(`Create failed: ${err?.body?.error?.message || err?.message || err}`, "warn");
          return false;
        }
      }},
    ],
  });
}

async function createVersionPrompt(profile, latestVersion, latestPoints) {
  if (!requireServer("version profiles")) return;
  if (profile.status === "archived") {
    toast("Archived profiles cannot be versioned. Reactivate first.", "warn");
    return;
  }
  // Pre-fill with the latest version's points so editing is incremental.
  const pointsText = latestPoints.map(p => `${p.name}, ${p.unit || ""}, ${p.sourcePathTemplate}`).join("\n");
  const tplJson = JSON.stringify(latestVersion.sourceTemplate, null, 2);

  const tplArea = textarea({ rows: 4, value: tplJson });
  const pointsArea = textarea({ rows: 8, value: pointsText, placeholder: "name, unit, sourcePathTemplate" });
  const notesInput = input({ placeholder: "Optional release notes" });

  modal({
    title: `New version of ${profile.name} (current v${latestVersion.version})`,
    body: el("div", { class: "stack" }, [
      el("p", { class: "muted tiny" }, [
        "Creating a new version does NOT auto-upgrade existing bindings. Each asset stays pinned to its current version until an operator runs the upgrade flow (Phase 3).",
      ]),
      formRow("source_template JSON", tplArea),
      formRow("Points (name, unit, sourcePathTemplate)", pointsArea),
      formRow("Notes", notesInput),
    ]),
    actions: [
      { label: "Cancel" },
      { label: "Create version", variant: "primary", onClick: async () => {
        const points = pointsArea.value.split("\n").map(line => {
          const parts = line.split(",").map(s => s.trim());
          if (!parts[0]) return null;
          return { name: parts[0], unit: parts[1] || null, dataType: "number", sourcePathTemplate: parts[2] || "" };
        }).filter(Boolean);
        if (!points.length) { toast("Add at least one point", "warn"); return false; }
        let sourceTemplate = {};
        try { sourceTemplate = JSON.parse(tplArea.value || "{}"); }
        catch { toast("source_template must be valid JSON", "warn"); return false; }
        try {
          await api(`/api/asset-profiles/${profile.id}/versions`, { method: "POST", body: {
            sourceTemplate, points, notes: notesInput.value.trim() || null,
          }});
          toast("Version created", "success");
          renderProfilesAdmin();
        } catch (err) {
          toast(`Failed: ${err?.body?.error?.message || err?.message || err}`, "warn");
          return false;
        }
      }},
    ],
  });
}

async function editMetadataPrompt(profile) {
  if (!requireServer("edit profiles")) return;
  const nameInput = input({ value: profile.name });
  const descInput = textarea({ rows: 2, value: profile.description || "" });
  modal({
    title: "Edit profile metadata",
    body: el("div", { class: "stack" }, [
      formRow("Name", nameInput),
      formRow("Description", descInput),
    ]),
    actions: [
      { label: "Cancel" },
      { label: "Save", variant: "primary", onClick: async () => {
        try {
          // Fetch current ETag, then PATCH with If-Match.
          const fresh = await api(`/api/asset-profiles/${profile.id}`);
          const etag = fresh.__etag; // may be undefined; api() returns body, not headers — fall through
          await api(`/api/asset-profiles/${profile.id}`, {
            method: "PATCH",
            headers: etag ? { "if-match": etag } : {},
            body: {
              name: nameInput.value.trim(),
              description: descInput.value.trim() || null,
            },
          });
          toast("Metadata updated", "success");
          renderProfilesAdmin();
        } catch (err) {
          toast(`Failed: ${err?.body?.error?.message || err?.message || err}`, "warn");
          return false;
        }
      }},
    ],
  });
}

async function archive(profile) {
  if (!requireServer("archive profiles")) return;
  const ok = await confirm({ title: "Archive profile", message: `Archive ${profile.name}? New bindings will be blocked but existing bindings remain.`, confirmLabel: "Archive" });
  if (!ok) return;
  try {
    await api(`/api/asset-profiles/${profile.id}`, { method: "PATCH", body: { status: "archived" } });
    toast("Archived", "success");
    renderProfilesAdmin();
  } catch (err) {
    toast(`Failed: ${err?.body?.error?.message || err?.message || err}`, "warn");
  }
}

async function unarchive(profile) {
  if (!requireServer("reactivate profiles")) return;
  try {
    await api(`/api/asset-profiles/${profile.id}`, { method: "PATCH", body: { status: "active" } });
    toast("Reactivated", "success");
    renderProfilesAdmin();
  } catch (err) {
    toast(`Failed: ${err?.body?.error?.message || err?.message || err}`, "warn");
  }
}

async function deleteProfile(profile) {
  if (!requireServer("delete profiles")) return;
  if (profile.bindingCount > 0) {
    toast(`Refused: ${profile.bindingCount} binding(s) reference this profile. Archive instead.`, "warn");
    return;
  }
  const ok = await confirm({ title: "Delete profile", message: `Delete ${profile.name}? This permanently removes all versions + points.`, confirmLabel: "Delete", variant: "danger" });
  if (!ok) return;
  try {
    await api(`/api/asset-profiles/${profile.id}`, { method: "DELETE" });
    toast("Deleted", "success");
    sessionStorage.removeItem(SS_SELECTED);
    renderProfilesAdmin();
  } catch (err) {
    if (err?.status === 409) {
      toast(`Refused: ${err.body?.error?.details?.bindingCount || "?"} binding(s) reference this profile.`, "warn");
    } else {
      toast(`Failed: ${err?.body?.error?.message || err?.message || err}`, "warn");
    }
  }
}
