// Rename re-resolve modal — shared component used by anywhere that
// PATCHes an enterprise or location name. Surfaces the affected
// asset_point_bindings the rename touches, lets the operator
// pick/skip per-binding, then commits via /re-resolve-bindings.
//
// Spec ref: docs/INDUSTRIAL_EDGE_PLATFORM_SPEC.md §4 — the asset path is
// the canonical address space. Renaming a node on that path must NOT
// silently re-route live MQTT/OPC UA subscriptions. This dialog is the
// audit-conscious checkpoint between "the name changed in the
// hierarchy" and "the bindings now subscribe under the new path".

import { el, modal, badge, toast } from "../core/ui.js";
import { api } from "../core/api.js";

/**
 * Open the re-resolve modal.
 *
 * @param {Object} args
 * @param {"enterprise"|"location"} args.kind  Rename axis.
 * @param {string} args.id                     The renamed entity's id.
 * @param {string} args.oldName                Pre-rename name (for the header).
 * @param {string} args.newName                Post-rename name.
 * @param {number} args.affectedBindings       Total affected count from PATCH.
 * @param {Array}  args.sample                 PATCH sample[] (max 25 rows).
 * @param {Function} [args.onComplete]         Callback after a successful commit.
 */
export function openReResolveModal({ kind, id, oldName, newName, affectedBindings, sample, onComplete }) {
  // Per-binding checkbox state. Sample bindings default checked. The
  // commit POST sends `bindingIds` (whitelist) when the user de-selects
  // any row, otherwise omits the field for "all affected".
  const checked = new Map(sample.map(s => [s.bindingId, true]));
  let working = false;

  const list = el("div", { class: "stack", style: { gap: "4px", maxHeight: "320px", overflowY: "auto" } },
    sample.map(row => {
      const cb = el("input", { type: "checkbox", checked: true, onChange: (e) => { checked.set(row.bindingId, e.target.checked); } });
      return el("label", { class: "activity-row", style: { gap: "12px", display: "flex", alignItems: "flex-start", cursor: "pointer" } }, [
        cb,
        el("div", { class: "stack", style: { flex: 1, gap: "2px" } }, [
          el("div", { class: "row", style: { gap: "8px" } }, [
            el("strong", {}, [row.assetName || row.assetId]),
            row.customMapping ? badge("custom mapping", "warn", { title: "No template — re-resolve will skip this row." }) : badge("profile-bound", "info"),
          ]),
          el("div", { class: "tiny mono muted" }, [
            el("span", { style: { textDecoration: "line-through", opacity: 0.7 } }, [row.oldPath]),
            " → ",
            el("span", { class: "strong" }, [row.newPath]),
          ]),
        ]),
      ]);
    })
  );

  const moreCount = Math.max(0, affectedBindings - sample.length);
  const summary = el("div", { class: "stack", style: { marginBottom: "8px" } }, [
    el("p", { class: "muted tiny" }, [
      `Renamed ${kind} "${oldName}" → "${newName}". `,
      `${affectedBindings} binding${affectedBindings === 1 ? "" : "s"} reference the old name. `,
      moreCount ? `Showing ${sample.length} of ${affectedBindings} below; commit applies to all selected (and the rest if no overrides).` : `All listed below.`,
    ]),
    el("p", { class: "tiny muted" }, [
      "Custom-mapping rows have no template and will be reported as skipped. ",
      "You can re-resolve them manually from each asset's Configuration tab.",
    ]),
  ]);

  modal({
    title: `Re-resolve binding paths`,
    body: el("div", { class: "stack" }, [
      summary,
      list.children.length ? list : el("div", { class: "muted tiny" }, ["No sample bindings returned."]),
    ]),
    actions: [
      { label: "Skip", onClick: () => {
        toast(`Rename committed; bindings left on the old path.`, "warn");
      }},
      { label: "Re-resolve selected", variant: "primary", onClick: async () => {
        if (working) return false;
        working = true;
        const include = sample.filter(s => checked.get(s.bindingId)).map(s => s.bindingId);
        const skip = sample.filter(s => !checked.get(s.bindingId)).map(s => s.bindingId);
        const path = kind === "enterprise"
          ? `/api/enterprises/${id}/re-resolve-bindings`
          : `/api/locations/${id}/re-resolve-bindings`;
        try {
          // If user kept all defaults, omit the lists so the server
          // re-resolves *every* affected binding (including those past
          // the sample window). When the user customised, send the
          // explicit allow-list; rows past the sample window are
          // implicitly skipped.
          const allDefaults = include.length === sample.length && skip.length === 0;
          const body = allDefaults ? {} : { bindingIds: include, skipBindingIds: skip };
          const r = await api(path, { method: "POST", body });
          const skippedCustom = (r.skipped || []).filter(x => x.reason === "custom_mapping").length;
          toast(
            `Re-resolved ${r.updated} binding${r.updated === 1 ? "" : "s"}` +
            (skippedCustom ? ` · ${skippedCustom} custom mapping${skippedCustom === 1 ? "" : "s"} skipped` : ""),
            r.updated > 0 ? "success" : "warn"
          );
          if (onComplete) onComplete();
        } catch (err) {
          toast(`Re-resolve failed: ${err?.message || err}`, "warn");
          working = false;
          return false;
        }
      }},
    ],
  });
}
