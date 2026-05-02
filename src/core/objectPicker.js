// Reusable object picker — replaces every "type the ID into a prompt"
// flow with a real browse + autocomplete experience.
//
// Usage:
//   const obj = await pickObject({ title: "Link an object", kinds: ["doc","asset","workItem","incident","revision","drawing","channel","teamSpace"] });
//   if (obj) console.log(obj.id, obj.kind);
//
// Returns the chosen entity (with `id`, `name`, `kind`, original record) or
// null if the user cancels. The picker filters as the user types (matches
// id + name + kind, case-insensitive); results are grouped by kind so
// browsing is fast.

import { el, modal, input } from "./ui.js";
import { state } from "./store.js";

/**
 * @typedef PickerEntity
 * @property {string} id
 * @property {string} name
 * @property {string} kind        Display kind (e.g. "Document", "Asset")
 * @property {string} kindShort   Short slug ("doc","asset",…)
 * @property {string} [meta]      Optional metadata line (e.g. revision label)
 * @property {any}    record      Original entity object from state.data
 */

/** @returns {PickerEntity[]} */
function listAll() {
  const d = state.data || {};
  const out = [];
  for (const x of d.documents || [])  out.push({ id: x.id, name: x.name || x.id, kind: "Document",     kindShort: "doc",       record: x });
  for (const x of d.drawings  || [])  out.push({ id: x.id, name: x.name || x.id, kind: "Drawing",      kindShort: "drawing",   record: x });
  for (const x of d.assets    || [])  out.push({ id: x.id, name: x.name || x.id, kind: "Asset",        kindShort: "asset",     record: x });
  for (const x of d.workItems || [])  out.push({ id: x.id, name: x.title || x.id, kind: "Work item",   kindShort: "workItem",  record: x, meta: x.type || "" });
  for (const x of d.revisions || [])  out.push({ id: x.id, name: `Rev ${x.label || ""}` + (x.docId ? ` of ${x.docId}` : ""), kind: "Revision", kindShort: "revision", record: x, meta: x.status || "" });
  for (const x of d.incidents || [])  out.push({ id: x.id, name: x.title || x.id, kind: "Incident",    kindShort: "incident",  record: x, meta: x.severity || "" });
  for (const x of d.channels  || [])  out.push({ id: x.id, name: `# ${x.name || x.id}`, kind: "Channel", kindShort: "channel", record: x });
  for (const x of d.teamSpaces|| [])  out.push({ id: x.id, name: x.name || x.id, kind: "Team space",   kindShort: "teamSpace", record: x });
  for (const x of d.projects  || [])  out.push({ id: x.id, name: x.name || x.id, kind: "Project",      kindShort: "project",   record: x });
  return out;
}

/**
 * Open the object picker.
 * @param {object} [opts]
 * @param {string} [opts.title]            Modal title.
 * @param {string} [opts.placeholder]      Search-box placeholder.
 * @param {string[]} [opts.kinds]          Filter to specific `kindShort` values.
 * @param {string} [opts.initialQuery]     Pre-populate the search box.
 * @returns {Promise<PickerEntity | null>}
 */
export function pickObject(opts = {}) {
  const allowed = opts.kinds && opts.kinds.length ? new Set(opts.kinds) : null;
  const all = listAll().filter(e => !allowed || allowed.has(e.kindShort));
  if (!all.length) {
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    let selected = /** @type {PickerEntity | null} */ (null);
    const search = input({
      placeholder: opts.placeholder || "Search by name or ID…",
      value: opts.initialQuery || "",
      autocomplete: "off",
    });
    const resultsHost = el("div", { class: "object-picker-results" });

    function render(query) {
      const q = (query || "").trim().toLowerCase();
      const matched = !q
        ? all
        : all.filter(e =>
            e.id.toLowerCase().includes(q) ||
            e.name.toLowerCase().includes(q) ||
            e.kind.toLowerCase().includes(q));

      // Group by kind, sorted within each group.
      /** @type {Record<string, PickerEntity[]>} */
      const groups = {};
      for (const e of matched) {
        (groups[e.kind] = groups[e.kind] || []).push(e);
      }
      const kinds = Object.keys(groups).sort();
      resultsHost.replaceChildren();
      if (!matched.length) {
        resultsHost.append(el("div", { class: "muted small", style: { padding: "12px" } },
          [`No matches for "${query || ""}".`]));
        return;
      }
      for (const k of kinds) {
        const items = groups[k].slice().sort((a, b) => a.name.localeCompare(b.name));
        resultsHost.append(
          el("div", { class: "object-picker-group" }, [
            el("div", { class: "object-picker-group-title" }, [
              k, el("span", { class: "tiny muted" }, [` · ${items.length}`]),
            ]),
            ...items.slice(0, 50).map(e => el("button", {
              class: `object-picker-item ${selected && selected.id === e.id && selected.kindShort === e.kindShort ? "selected" : ""}`,
              type: "button",
              onClick: () => {
                selected = e;
                handle.close();
                resolve(e);
              },
            }, [
              el("span", { class: "object-picker-id mono tiny muted" }, [e.id]),
              el("span", { class: "object-picker-name" }, [e.name]),
              el("span", { class: "object-picker-kind tiny muted" }, [e.kind + (e.meta ? ` · ${e.meta}` : "")]),
            ])),
            items.length > 50
              ? el("div", { class: "tiny muted", style: { padding: "4px 12px" } },
                  [`+ ${items.length - 50} more — refine search`])
              : null,
          ])
        );
      }
    }

    /** @type {any} */ (search).addEventListener("input", () => render(/** @type {HTMLInputElement} */ (search).value));
    // Pressing Enter picks the first visible row — fast keyboard flow.
    /** @type {any} */ (search).addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      const first = resultsHost.querySelector(".object-picker-item");
      if (first instanceof HTMLElement) first.click();
    });

    const handle = modal({
      title: opts.title || "Pick an object",
      body: el("div", { class: "stack object-picker" }, [
        search,
        el("div", { class: "tiny muted" }, [
          `Searching ${all.length} item${all.length === 1 ? "" : "s"} across the workspace.`,
        ]),
        resultsHost,
      ]),
      actions: [
        { label: "Cancel", onClick: () => { resolve(null); } },
      ],
    });

    render("");
    setTimeout(() => { try { /** @type {HTMLElement} */ (search).focus(); } catch {} }, 0);
  });
}
