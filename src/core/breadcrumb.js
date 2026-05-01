// Breadcrumb helper (UX-G).
//
// Renders a WAI-ARIA-compliant Breadcrumb pattern as a sub-header
// inside a screen's main pane. Distinct from the existing top-bar
// breadcrumb in `src/shell/header.js`, which shows
// `org / workspace / current-route` at app-level.
//
// Use this in screens that need to show the user's path WITHIN a
// resource — e.g. `Projects / Project Alpha / Sprint 3`. The audit
// flagged screens like `workBoard` that have no breadcrumb at all,
// leaving the user with no escape hatch back up the hierarchy.
//
// API:
//   breadcrumb([
//     { label: "Projects", route: "/projects" },
//     { label: "Project Alpha", route: `/work-board/${pid}` },
//     { label: "Sprint 3" },                  // current — no route
//   ])
//
// Each item:
//   - `label`  visible text (required)
//   - `route`  SPA path to navigate to on click. Items without a
//              route render as plain text — the current page must
//              not be a link, per WAI-ARIA pattern.
//
// Markup:
//   <nav aria-label="Breadcrumb" class="breadcrumb-trail">
//     <ol>
//       <li>             ← link
//         <button class="breadcrumb-link" type="button">Projects</button>
//       </li>
//       <li class="breadcrumb-sep" aria-hidden="true">/</li>
//       <li>             ← current page
//         <span class="breadcrumb-current" aria-current="page">Sprint 3</span>
//       </li>
//     </ol>
//   </nav>

import { el } from "./ui.js";
import { navigate } from "./router.js";

/**
 * Build a breadcrumb nav node from a list of crumbs.
 *
 * @param {Array<{ label: string, route?: string }>} items
 * @returns {Node} a `<nav class="breadcrumb-trail">` element, or a
 *   no-op empty-text fragment if the list is empty (so callers can
 *   unconditionally insert without null checks).
 */
export function breadcrumb(items = []) {
  if (!Array.isArray(items) || items.length === 0) {
    // Empty input renders nothing — caller can insert
    // unconditionally without guarding for empty data.
    return document.createTextNode("");
  }

  const ol = el("ol", { class: "breadcrumb-list" });
  const lastIdx = items.length - 1;

  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (!it || !it.label) continue;

    const isCurrent = i === lastIdx;
    const item = el("li", {});
    if (isCurrent || !it.route) {
      // Current page — plain text, marked aria-current.
      item.append(el("span", {
        class: "breadcrumb-current",
        "aria-current": "page",
      }, [String(it.label)]));
    } else {
      // Earlier crumb — clickable button that drives the SPA router.
      // Using <button> over <a> because the codebase uses hash-based
      // navigation via `navigate()`; an <a href="#/foo"> would also
      // work but routes are constructed from JS, not HTML.
      item.append(el("button", {
        class: "breadcrumb-link",
        type: "button",
        onClick: () => navigate(it.route),
      }, [String(it.label)]));
    }
    ol.append(item);

    // Add a separator between items (decorative, hidden from AT).
    if (!isCurrent) {
      ol.append(el("li", {
        class: "breadcrumb-sep",
        "aria-hidden": "true",
      }, ["/"]));
    }
  }

  return el("nav", {
    class: "breadcrumb-trail",
    "aria-label": "Breadcrumb",
  }, [ol]);
}

export default breadcrumb;
