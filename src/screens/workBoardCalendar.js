// Month-grid calendar view, extracted from workBoard.js (Phase 4
// decomposition). Used by both the per-project board and the
// consolidated /work view via the shared `scope` contract:
//
//   scope.id          — namespace key for sessionStorage state
//   scope.rerender()  — re-render hook fired after a state change
//
// The calendar is independent enough from the rest of workBoard.js
// that pulling it into its own module is a clean win — about 160 LOC
// out, no behavioural change, and a single import in workBoard.js.

import { el, card } from "../core/ui.js";
import { openItem } from "./workBoardItem.js";

// "Done" rendering options. Each persists per scope as
// `board.cal.doneStyle.<scopeId>`. Default is "green" — finished work
// stays visible but with a leading ✓ on a green background so it
// doesn't compete with severity-coloured open work.
const DONE_STYLE_KEY = (scopeId) => `board.cal.doneStyle.${scopeId}`;
const DONE_STYLES = [
  { id: "green",  label: "Green pill" },
  { id: "strike", label: "Strike out" },
  { id: "dim",    label: "Dimmed" },
  { id: "hidden", label: "Hidden" },
];
const DONE_STATUSES = new Set(["Done", "Closed", "Approved"]);

/**
 * Render the month-grid calendar.
 * @param {any[]} items — work items to plot (already filtered by scope)
 * @param {{ id: string, rerender: () => void }} scope
 */
export function calendarView(items, scope) {
  const monthKey = `board.cal.${scope.id}`;
  const cur = sessionStorage.getItem(monthKey);
  const today = new Date();
  const anchor = cur ? new Date(cur + "-01T00:00:00") : new Date(today.getFullYear(), today.getMonth(), 1);
  const year = anchor.getFullYear();
  const month = anchor.getMonth();
  const doneStyle = sessionStorage.getItem(DONE_STYLE_KEY(scope.id)) || "green";

  // Hidden mode: drop done items before the day-grouping pass so the
  // counters and "+N more" overflow stay accurate.
  const visibleItems = doneStyle === "hidden"
    ? items.filter(w => !DONE_STATUSES.has(w.status))
    : items;

  // Group items by ISO date.
  const byDay = new Map();
  for (const w of visibleItems) {
    if (!w.due) continue;
    const d = new Date(w.due);
    if (d.getFullYear() !== year || d.getMonth() !== month) continue;
    const k = d.toISOString().slice(0, 10);
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push(w);
  }

  // Year picker range: ±10 around the current view, but stretched to
  // cover any item with a due date outside that window. Means a user
  // who lands on May 2026 with a 2018 task can still navigate there.
  const yearRange = computeYearRange(items, year);
  const setNav = (nextYear, nextMonth) => {
    sessionStorage.setItem(monthKey, `${nextYear}-${String(nextMonth + 1).padStart(2, "0")}`);
    scope.rerender();
  };
  const stepMonth = (delta) => {
    const next = new Date(year, month + delta, 1);
    setNav(next.getFullYear(), next.getMonth());
  };
  const stepYear = (delta) => setNav(year + delta, month);
  const goToday = () => setNav(today.getFullYear(), today.getMonth());

  const monthSel = el("select", { class: "select sm", "aria-label": "Jump to month" });
  ["January","February","March","April","May","June","July","August","September","October","November","December"]
    .forEach((name, i) => {
      const opt = document.createElement("option");
      opt.value = String(i); opt.textContent = name;
      if (i === month) opt.selected = true;
      monthSel.append(opt);
    });
  monthSel.addEventListener("change", () => setNav(year, parseInt(/** @type {HTMLSelectElement} */ (monthSel).value, 10)));

  const yearSel = el("select", { class: "select sm", "aria-label": "Jump to year" });
  for (const y of yearRange) {
    const opt = document.createElement("option");
    opt.value = String(y); opt.textContent = String(y);
    if (y === year) opt.selected = true;
    yearSel.append(opt);
  }
  yearSel.addEventListener("change", () => setNav(parseInt(/** @type {HTMLSelectElement} */ (yearSel).value, 10), month));

  const doneStyleSel = el("select", {
    class: "select sm",
    "aria-label": "How to render done items",
    title: "Render style for items with status Done / Closed / Approved",
  });
  for (const opt of DONE_STYLES) {
    const o = document.createElement("option");
    o.value = opt.id; o.textContent = opt.label;
    if (opt.id === doneStyle) o.selected = true;
    doneStyleSel.append(o);
  }
  doneStyleSel.addEventListener("change", () => {
    sessionStorage.setItem(DONE_STYLE_KEY(scope.id), /** @type {HTMLSelectElement} */ (doneStyleSel).value);
    scope.rerender();
  });

  // First-of-month weekday (Mon=0 … Sun=6).
  const first = new Date(year, month, 1);
  const startCol = (first.getDay() + 6) % 7;
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells = [];
  for (let i = 0; i < startCol; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(new Date(year, month, d));
  while (cells.length % 7) cells.push(null);

  const headerRow = el("div", { class: "row spread mb-2", style: { gap: "8px", flexWrap: "wrap" } }, [
    el("div", { class: "row", style: { gap: "4px", alignItems: "center" } }, [
      el("button", { class: "btn sm icon-btn", onClick: () => stepYear(-1), title: "Previous year", "aria-label": "Previous year" }, ["«"]),
      el("button", { class: "btn sm icon-btn", onClick: () => stepMonth(-1), title: "Previous month", "aria-label": "Previous month" }, ["‹"]),
      monthSel,
      yearSel,
      el("button", { class: "btn sm icon-btn", onClick: () => stepMonth(1), title: "Next month", "aria-label": "Next month" }, ["›"]),
      el("button", { class: "btn sm icon-btn", onClick: () => stepYear(1), title: "Next year", "aria-label": "Next year" }, ["»"]),
      el("button", { class: "btn sm", onClick: goToday, title: "Jump to current month" }, ["Today"]),
    ]),
    el("div", { class: "row", style: { gap: "6px", alignItems: "center" } }, [
      el("span", { class: "tiny muted" }, ["Done items:"]),
      doneStyleSel,
    ]),
  ]);

  const weekdayHeader = el("div", { class: "calendar-grid header" },
    ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"].map(n => el("div", { class: "calendar-cell head" }, [n]))
  );

  const grid = el("div", { class: "calendar-grid" }, cells.map(c => {
    if (!c) return el("div", { class: "calendar-cell empty" });
    const k = c.toISOString().slice(0, 10);
    const list = byDay.get(k) || [];
    const isToday = c.toDateString() === today.toDateString();
    return el("div", { class: `calendar-cell ${isToday ? "today" : ""}` }, [
      el("div", { class: "calendar-date" }, [String(c.getDate())]),
      ...list.slice(0, 3).map(w => calendarPill(w, doneStyle)),
      list.length > 3 ? el("div", { class: "tiny muted" }, ["+", String(list.length - 3), " more"]) : null,
    ]);
  }));

  return card("Calendar", el("div", {}, [headerRow, weekdayHeader, grid]), {
    subtitle: "Items plotted by due date. Click a pill to open. Spec §6.2.",
  });
}

// Shared pill renderer so /work-board and /work look identical and the
// done-style choice applies uniformly.
function calendarPill(w, doneStyle) {
  const isDone = DONE_STATUSES.has(w.status);
  const sev = `sev-${w.severity || "low"}`;
  const doneClass = isDone ? `done done-${doneStyle}` : "";
  const titlePrefix = isDone ? "✓ " : "";
  return el("button", {
    class: `calendar-pill ${sev} ${doneClass}`.trim(),
    title: titlePrefix + (w.title || w.id) + (isDone ? ` (${w.status})` : ""),
    onClick: () => openItem(w.id),
  }, [
    isDone ? el("span", { "aria-hidden": "true", style: { marginRight: "3px" } }, ["✓"]) : null,
    w.id + " · " + (w.title || "").slice(0, 18),
  ]);
}

/** Compute the year range for the dropdown. ±10 around viewYear by
 *  default, stretched to cover any item with a due date outside that
 *  window so users with old/future tasks can still navigate. */
export function computeYearRange(items, viewYear) {
  const today = new Date();
  let lo = today.getFullYear() - 10;
  let hi = today.getFullYear() + 10;
  for (const w of items) {
    if (!w.due) continue;
    const y = new Date(w.due).getFullYear();
    if (Number.isFinite(y)) {
      if (y < lo) lo = y;
      if (y > hi) hi = y;
    }
  }
  if (viewYear < lo) lo = viewYear;
  if (viewYear > hi) hi = viewYear;
  const out = [];
  for (let y = lo; y <= hi; y++) out.push(y);
  return out;
}
