// Single-key quick actions (spec §12.4).
// Implemented as a key dispatcher that ignores events when an input/textarea
// or contenteditable has focus.

import { navigate } from "./router.js";
import { openPalette } from "./palette.js";
import { modal, el } from "./ui.js";

const HELP = [
  ["C",   "Open create menu"],
  ["G",   "Go — open command palette"],
  ["A",   "Assign / open approvals"],
  ["/",   "Focus search box"],
  ["?",   "Show this help"],
  ["⌘K",  "Command palette"],
];

function isTyping(e) {
  const t = e.target;
  return (
    t.tagName === "INPUT" ||
    t.tagName === "TEXTAREA" ||
    t.tagName === "SELECT" ||
    t.isContentEditable
  );
}

export function installHotkeys() {
  document.addEventListener("keydown", (e) => {
    if (isTyping(e)) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return; // leave combos to their owners

    const k = e.key.toLowerCase();
    if (k === "c") { e.preventDefault(); openCreateMenu(); }
    else if (k === "g") { e.preventDefault(); openPalette(); }
    else if (k === "a") { e.preventDefault(); navigate("/approvals"); }
    else if (k === "/") {
      e.preventDefault();
      const s = /** @type {HTMLElement | null} */ (document.querySelector(".search-input"));
      if (s) s.focus();
    }
    else if (k === "?") { e.preventDefault(); showHelp(); }
  });
}

function openCreateMenu() {
  modal({
    title: "Create",
    body: el("div", { class: "stack" }, [
      btn("+ Work item",  () => navigate("/work-board/PRJ-1")),
      btn("+ Incident",   () => navigate("/incidents")),
      btn("+ Document",   () => navigate("/docs")),
      btn("+ Drawing",    () => navigate("/drawings")),
      btn("+ Channel",    () => navigate("/team-spaces")),
    ]),
    actions: [{ label: "Close" }],
  });
}

function showHelp() {
  modal({
    title: "Keyboard shortcuts",
    body: el("table", { class: "table" }, [
      el("tbody", {}, HELP.map(([k, v]) =>
        el("tr", {}, [el("td", { class: "mono" }, [k]), el("td", {}, [v])])
      )),
    ]),
    actions: [{ label: "Close" }],
  });
}

function btn(label, onClick) {
  return el("button", { class: "btn", onClick: () => { onClick(); } }, [label]);
}
