# UX / Accessibility Audit — Task Document

Source: regulator-style audit performed Apr 25 2026 against `main` after the
Hub/portals/groups merge. See chat thread for the full evidence-based
findings; this doc is the **actionable plan**, organised into Major and Minor
tasks with severity, file pointers, acceptance criteria, and execution status.

Tasks are tracked **in this file**. Update the status column as work
progresses (`[ ]` pending → `[~]` in progress → `[x]` done → `[-]` skipped).

---

## Conventions

* **Sev**: Critical / High / Medium / Low / Nit
* **WCAG**: cited where applicable (2.2 AA criteria)
* **Files** are an indicative list, not exhaustive — fix wherever the pattern
  occurs.
* Each task has an **acceptance** clause that defines "done."

---

## Major tasks (regulator-blocking — High / Critical)

### MJ-1 — Make all clickable rows keyboard-accessible &nbsp;`[x]`

**Sev**: High &nbsp; • &nbsp; **WCAG**: 2.1.1, 4.1.2, 2.4.7

Across `tree-item`, `activity-row`, `dock-item`, table rows, palette items,
and chips, the SPA uses `<div onClick>` with no `role`, `tabindex`, or
keyboard handler. AT and keyboard-only users can't activate them.

**Files**: `src/core/ui.js` (`table()`, `chip()`), `src/shell/leftPanel.js`,
`src/shell/dock.js`, `src/screens/search.js`, `src/screens/home.js`,
`src/screens/uns.js`, `src/core/palette.js`.

**Acceptance**:
* Every clickable element has either `<button>` semantics, `<a href>`, or
  `role="button" tabindex="0"` + Enter/Space handler.
* Tab order is sensible (top-to-bottom, left-to-right).
* `:focus-visible` is visible on every interactive element.

---

### MJ-2 — Reserve safe area for the fixed Operations Dock &nbsp;`[x]`

**Sev**: High &nbsp; • &nbsp; **WCAG**: 1.4.10 *Reflow*

`.operations-dock` is `position: fixed; bottom: 0; height: 48px` but
`.screen-container` has no `padding-bottom`, so the last 48 px of every
screen is hidden behind the dock when it is visible.

**Files**: `styles.css`.

**Acceptance**:
* When `state.ui.dockVisible` is true, `.screen-container` reserves enough
  bottom padding so its content is not occluded by the dock at any
  viewport size.
* When the dock is hidden, no extra space is reserved.

---

### MJ-3 — Resolve role / identity desync (header dropdown vs Demo identity) &nbsp;`[x]`

**Sev**: High

`currentRole()` reads `state.ui.role` (header dropdown) but
`currentUserId()` reads `state.data.currentUserId` (Admin → Demo identity).
A user can set role = "Viewer/Auditor" in the header while impersonating an
IT admin in Admin → groups gating uses the IT user, but capability gates
use the dropdown role. They mean two different things and both look
authoritative.

**Files**: `src/shell/header.js`, `src/screens/admin.js`, `src/core/groups.js`.

**Acceptance**:
* The header dropdown is **either** removed in favour of the Demo identity
  picker, **or** clearly labelled "Acting as" and changing it also moves
  `state.data.currentUserId` to that user's id (and the user's stored role
  drives `currentRole()`).
* No state where the two controls disagree silently.

---

### MJ-4 — Fix `formRow()` so labels are programmatically associated &nbsp;`[x]`

**Sev**: High &nbsp; • &nbsp; **WCAG**: 1.3.1, 4.1.2

`formRow(label, input)` builds `<label>label</label>{input}` with no
`htmlFor`/`id`. Clicking the label doesn't focus the input; AT may not
pair them.

**Files**: `src/core/ui.js`.

**Acceptance**:
* `formRow` auto-generates a unique id for the input if it doesn't have
  one and sets `<label htmlFor=...>` to match. Already-id'd inputs are
  honoured.
* Clicking the label focuses the control.

---

### MJ-5 — Make the View ▾ menu a proper disclosure &nbsp;`[x]`

**Sev**: High &nbsp; • &nbsp; **WCAG**: 4.1.2, ARIA APG (Disclosure / Menu)

Trigger has no `aria-expanded` / `aria-controls`; popover declares
`role="menu"` but contains `<label><checkbox>` rows; Escape doesn't close.

**Files**: `src/shell/header.js`, `styles.css`.

**Acceptance**:
* Trigger button has `aria-expanded` and `aria-controls` referencing the
  popover.
* Popover dropped from `role=menu` to a labelled `<div role="dialog"
  aria-label="…">` (it's a settings panel, not a menubar).
* Escape, click-outside, and focusing-away all close it; focus returns
  to the trigger.

---

### MJ-6 — Stop full-shell rerender + full-data persist on every mutation &nbsp;`[x]`

**Sev**: High &nbsp; • &nbsp; performance / focus loss

`subscribe(() => { renderShell(); rerenderCurrent(); … })` runs the entire
shell + screen on every `update()`. `persist()` re-serialises the whole
seed (`state.data`) on every notify.

**Files**: `src/app.js`, `src/core/store.js`.

**Acceptance**:
* `persist()` is debounced (e.g. `requestIdleCallback` with a 250 ms
  fallback) so a burst of `update()`s writes once.
* Optionally: skip persist when only `state.ui` changed but the data
  payload is unchanged (cheap shallow-equal).
* Subscribe-driven rerender remains correct (we don't have time to
  re-architect this in the audit-fix branch).

---

### MJ-7 — Restore a connectivity indicator for non-IT users &nbsp;`[x]`

**Sev**: High

Today, `authOnlyBadge()` hides the "● connected" dot from non-IT users to
avoid leaking server identity. It hides too much: signed-in users have no
way to know their writes are queued offline.

**Files**: `src/shell/header.js`.

**Acceptance**:
* All users (regardless of group) see an *online / offline* pill that
  doesn't expose backend identity (no version, no host, just "Online" or
  "Offline / queued"). The IT-detailed badge keeps its current behaviour.

---

## Minor tasks (Medium / Low / Nit)

### MN-1 — Drop `e.preventDefault() + window.open` in Hub tiles &nbsp;`[x]`
**Sev**: Medium &nbsp; • &nbsp; mobile-friendly nav

Today plain click is forced through `window.open(href, "_blank", "noopener")`
which mobile browsers often block.

**Files**: `src/screens/hub.js`.

**Acceptance**: Plain click follows the anchor (`target="_blank"`); Cmd /
Ctrl / middle-click still work; no JS popup. `rel` becomes `noopener
noreferrer`.

---

### MN-2 — Set `document.title` per route and per portal &nbsp;`[x]`
**Sev**: Medium &nbsp; • &nbsp; multi-tab UX, browser history

Tabs all read "FORGE — Engineering Collaboration Platform"; impossible to
tell apart in browser-history or tab-strip.

**Files**: `src/shell/header.js` (or new `src/core/title.js`).

**Acceptance**: Title is `"<Page> · <Portal?> · FORGE"`, e.g. "Industrial
Automation & DAQ · FORGE" in a portal tab, "Asset HX-01 · FORGE" on a
detail page.

---

### MN-3 — Use entity names in breadcrumbs for parameterised routes &nbsp;`[x]`
**Sev**: Medium

`/asset/:id` shows "Asset", not the asset name. Same for doc, drawing,
team-space, work-board, channel, incident.

**Files**: `src/shell/header.js`.

**Acceptance**: Breadcrumb / page title resolves the entity by id and
shows its `name` / `title`.

---

### MN-4 — Fix two `<h1>` on the Hub &nbsp;`[x]`
**Sev**: Medium &nbsp; • &nbsp; WCAG 2.4.6

Header h1 ("FORGE Hub") + hero h1 ("Welcome…") on the same screen.

**Files**: `src/screens/hub.js`.

**Acceptance**: Hub hero title becomes `<h2>` (or the header h1 hides on
the hub route).

---

### MN-5 — `.btn.sm` minimum target size 24×24 &nbsp;`[x]`
**Sev**: Medium &nbsp; • &nbsp; WCAG 2.5.8

`.btn.sm` is 26 px tall but single-character buttons (× delete) can be
< 24×24 hit area in dense rows.

**Files**: `styles.css`.

**Acceptance**: All `.btn.sm` and inline icon buttons are ≥ 24×24 px.

---

### MN-6 — Replace `window.confirm` / `window.prompt` with the styled `confirm()` helper &nbsp;`[x]`
**Sev**: Medium

Native dialogs are inconsistent with the design language and unstyleable.

**Files**: `src/shell/header.js`, `src/screens/admin.js`, `src/screens/channel.js`,
`src/screens/approvals.js`, `src/screens/erp.js`, `src/screens/mqtt.js`,
`src/screens/integrations.js`, `src/screens/workBoard.js`.

**Acceptance**: No `window.confirm`/`window.prompt` calls remain in the
client SPA. Replaced with `confirm()` / `modal()` from `core/ui.js`.

---

### MN-7 — Audit log denied access attempts &nbsp;`[x]`
**Sev**: Medium

Today the Forbidden screen is friendly but the attempt is not audited.

**Files**: `src/app.js`.

**Acceptance**: Hitting a route the viewer can't access calls
`audit("access.denied", route, { groups: [...] })`.

---

### MN-8 — Audit `asset.assign` with human-readable summary &nbsp;`[x]`
**Sev**: Low

`audit("asset.assign", a.id, { userId, groupId })` records ids only.

**Files**: `src/screens/assetDetail.js`.

**Acceptance**: Detail object includes `userName`, `groupName` for offline
review.

---

### MN-9 — Service worker precache covers new files &nbsp;`[x]`
**Sev**: Low

`hub.js` and `groups.js` rely on the SW's `/src/*` stale-while-revalidate
rule but are not in the precache list.

**Files**: `sw.js`.

**Acceptance**: Precache list updated; SW cache version bumped.

---

### MN-10 — `rel="noopener noreferrer"` on Hub tiles &nbsp;`[x]`
**Sev**: Low

Defense-in-depth.

**Files**: `src/screens/hub.js`.

**Acceptance**: `rel="noopener noreferrer"` on every `target="_blank"` anchor.

---

### MN-11 — Microcopy: "Sign in" everywhere; show Cmd/Ctrl in Hub tip &nbsp;`[x]`
**Sev**: Low

"Login failed" should be "Sign-in failed"; Hub footer says "Click ⌘K"
which is mac-only despite the keybinding being cross-platform.

**Files**: `src/shell/header.js`, `src/screens/hub.js`.

---

### MN-12 — Header search input has an `aria-label` &nbsp;`[x]`
**Sev**: Medium &nbsp; • &nbsp; WCAG 4.1.2

**Files**: `src/shell/header.js`.

---

### MN-13 — Header role select has an `aria-label` ("Acting as") &nbsp;`[x]`
**Sev**: Medium &nbsp; • &nbsp; WCAG 4.1.2

**Files**: `src/shell/header.js`.

---

### MN-14 — Modal first-focus skips the Close (ghost) button &nbsp;`[x]`
**Sev**: Medium &nbsp; • &nbsp; WCAG 2.4.3

`backdrop.querySelector("button:not(.ghost), input, select, textarea, button")`
falls through to the trailing `, button` and focuses the Close header
button before the body's primary action.

**Files**: `src/core/ui.js`.

**Acceptance**: First-focus is the first non-ghost interactive in the
**body** (or the primary footer button if no body field is focusable).

---

## Out of scope for this PR

The following items from the audit remain open and should be tracked
separately. They require deeper redesign than the audit-fix branch is
intended for.

* Kanban keyboard equivalent for drag/drop (A-2). Needs a "Move to
  column…" picker on each card and a roving tabindex. Will land in a
  dedicated workboard PR.
* Command palette as a true ARIA combobox + listbox (A-7). Same.
* Theme-light primary button hard-coded `#0b1220` text (A-3). Needs a
  design-system pass on theme tokens.
* Density / heading-scale rework across cards (V-2, V-4). Design system
  level.
* Multi-tab workspace context in the URL (P-6) — needs a story for
  per-tab localStorage scope.

---

## Execution log

| Date | Task | Outcome |
|------|------|---------|
| 2026-04-25 | branch `cursor/ux-audit-fixes-2330` created | from `main@e35736b` |
| 2026-04-25 | MJ-1 .. MJ-7, MN-1 .. MN-14 | all in-scope tasks completed; tests + manual GUI walk-through pass |
