# FORGE — UX/UI audit + improvement plan

Snapshot: post Phase 7f merge (commit `a587e22`). Audit performed top-down across `styles.css` (2242 lines), `src/core/ui.js` (502 lines), 31 screens (10 352 LOC total), `index.html`, app shell wiring (`app.js`, `src/shell/`), and the existing command palette (`src/core/palette.js`).

The platform's foundation is healthy — there is a token system, ARIA-correct modal/drawer/tab primitives, a focus-trap, a wired Cmd+K palette, an opt-in skip-link, and layout toggles for hide-rail / hide-left / hide-right / hide-header / focus-mode / portal-mode. The friction sits in **mobile breakage below 900 px**, **scattered inline styles in screens**, **light-theme contrast on muted text**, **inconsistent `<div>` vs `<button>` for clickable rows**, and **non-existent loading / empty / error state primitives** so each screen rolls its own.

## Findings

Severity prefixes: **[H]** breaks something, **[M]** friction or inconsistency, **[L]** polish.

### CSS / design system

- **[H]** Two media queries only (`@media (max-width: 1280px)` and `(max-width: 900px)` — `styles.css:1882`, `:1895`). Below 900 px the side panels are hidden but `.three-col` and `.two-col` keep their desktop column counts. `card-grid minmax(240px, 1fr)` on phones renders cramped 1-column cards with too much horizontal padding.
- **[M]** Light-theme `--muted` is `#4b576b` (`:72`); on `--panel #eef2f8` that's ~3.2:1 contrast — under AA for 14 px text. Comment at `:27` notes the dark-mode lift was applied but light wasn't re-checked.
- **[M]** No `@media (prefers-reduced-motion: reduce)` rule. `transition: all 0.15s` runs regardless of user setting — fails AAA for vestibular triggers.
- **[M]** `<body class="theme-dark">` is hardcoded in `index.html`; user's `prefers-color-scheme: light` is ignored on first load. There's no theme-toggle UI either.
- **[M]** Transition timing scattered: `0.1s`, `0.12s`, `0.15s`, `0.2s`, `0.3s` — five values, no token.
- **[L]** Scrollbar styling is WebKit-only (`::-webkit-scrollbar`); Firefox loses the themed look.
- **[L]** Skip-link uses the legacy `left: -9999px` hide pattern (`:1797`). Modern equivalent (`clip-path: inset(50%)`) is more screen-reader-friendly.
- **[L]** No `forced-colors` mode handling — Windows high-contrast users get arbitrary palette overrides; we should opt into `forced-color-adjust` on key components.
- **[L]** No `@media print` styles — document / audit / incident screens print with full chrome.

### Layout primitives

- **[H]** `.three-col`, `.two-col` have no responsive collapse (`:1706`, `:1712`). Both stay multi-column down to 0 px.
- **[M]** `.card-grid` `minmax(240px, 1fr)` is too wide for phones — 240 px-min cards force a single column with excessive surrounding whitespace because `.screen-container` has only `--space-4` padding.

### Component coverage

- **[M]** No skeleton / loading-state primitive. ~12 screens render `"Loading…"` as plain text inside their main pane. Inconsistent across `assetDashboard.js:32`, `assetConfig.js:32`, `admin.js:496`, `docViewer.js:338`.
- **[M]** No empty-state primitive. Each screen rolls its own `el("div", { class: "muted center" }, ["No X yet"])` — copy and structure drift.
- **[M]** No error-state primitive. `assetDashboard.js:93` builds `.callout danger` ad-hoc; other screens use raw `toast()` + nothing on screen.
- **[M]** Toasts (`ui.js:205`) auto-dismiss at 2.8 s with no manual dismiss button, no hover-to-pause, no action-button slot. Errors and successes share the same UX — sticky errors aren't possible.

### Interactive semantics

- **[M]** `class="activity-row"` is rendered as `<div>` in 5+ admin.js places (lines 406, 456, 563, 661, 703) and as `<button>` everywhere else. The `installRowKeyboardHandlers()` MutationObserver in `ui.js:69` is the safety net that papers over this — fragile because it relies on observer timing and a fixed selector list.
- **[L]** Some buttons rely on icon-only content with no `aria-label` (e.g. `docViewer.js:749` `aria-label: "previous month"` is correct; many screen-specific icon buttons aren't).

### Inline styles in screens

`grep -c "style:\s*{"` ranking (top six):

| Screen | Inline `style:` count |
|---|---|
| `workBoard.js` | 20 |
| `assetDashboard.js` | 20 |
| `docViewer.js` | 14 |
| `profilesAdmin.js` | 13 |
| `drawingViewer.js` | 12 |
| `admin.js` | 11 |

Most are spacing (`marginTop: "8px"`, `gap: "12px"`) or one-off widths (`width: "100px"`, `flex: 1`). With ~100 inline-style occurrences across the codebase, the mix of `var(--space-3)` in CSS but `8px` in JS makes theme/density adjustments fragile.

### Accessibility

- **[M]** Light theme contrast (above).
- **[M]** Toast lacks manual dismiss; `aria-live="polite"` is on the root but a sticky error a screen-reader needs to dismiss can't be acted on.
- **[L]** Modal close button is labelled `"Close"` text (`ui.js:252`) — fine, but inconsistent with the drawer using `"Close"` too. A small "×" glyph with `aria-label="Close"` is more conventional and saves header real estate on phones.
- **[L]** Some icon-only buttons in screens missing `aria-label`.

### Performance

- **[M]** `assetDashboard.js` already implements IntersectionObserver-driven lazy chart instantiation (Phase 6). No other screen does — but `workBoard.js` kanban / `audit.js` tables would benefit at scale.
- **[L]** `docViewer.js:339-356` initializes PDF.js inline during render, blocking paint. Hoisting to `requestIdleCallback` or first-interaction would let the shell paint sooner.

### Information architecture

- **[L]** Breadcrumbs present in some screens, absent in others (`workBoard.js` has no breadcrumb, just the project title). No central helper.
- **[L]** Header search input is wired (`styles.css:375`) but does not exist as a working filter in most screens; only the command palette (Cmd+K) is functional. Either remove it or wire it.

## Improvement plan — phased PRs

Same cadence as Phase 7a–7f: one focused PR per phase, tests where applicable, CI green before next phase, no scope creep.

| Phase | Focus | Scope |
|---|---|---|
| **UX-A** | **Motion + theme + scrollbars + skip-link** foundation | `--timing-*` tokens, `prefers-reduced-motion`, `prefers-color-scheme` honoured on first load + theme toggle in header, Firefox scrollbar styling, modern skip-link clip-path, basic `forced-colors` opt-ins |
| **UX-B** | **Responsive layout** | Tablet (1024 px) + phone (640 px) breakpoints, `.three-col` / `.two-col` / `.card-grid` collapse, header search becomes icon-only on phones, modal/drawer phone treatment, `.app-shell` mobile bottom-nav fallback for the rail |
| **UX-C** | **Light theme contrast + token re-audit** | Lift `--muted` light, audit every token pair against AA, add `--ring`, add `--shadow-sm/md/lg` tokens, document tokens at top of `styles.css` |
| **UX-D** | **Loading / empty / error / toast UX** | New `loadingState()`, `emptyState()`, `errorState()`, `skeleton()` primitives in `ui.js`; toast manual-dismiss + action slot + variant timeouts + hover-pause; replace 12 inline "Loading…" sites |
| **UX-E** | **Interactive semantic cleanup** | All `class="activity-row"` / `kanban-card` / `tree-item` standardized to `<button>` (or `<a>` where it's a real link); audit clickable divs; tighten `installRowKeyboardHandlers` as a safety-net not a load-bearing default |
| **UX-F** | **Inline-style cleanup + utilities** | Spacing utilities `.mt-{1..6}`, `.gap-{1..6}` etc.; migrate top-3 offenders (`workBoard.js`, `assetDashboard.js`, `docViewer.js`); doc the conventions |
| **UX-G** | **Page-level polish** | Breadcrumb helper, page sub-header pattern, print styles for docs/audit/incident, idle-init for heavy viewers (PDF/CAD/IFC) |

Each phase ships independently and is reversible. Phase A unblocks B; B unblocks C in the sense that mobile contrast can only be checked once mobile renders correctly; D, E, F, G are independent of each other.
