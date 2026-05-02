// Tiny UI helpers — no framework.

export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "style" && typeof v === "object") Object.assign(node.style, v);
    else if (k === "dataset") Object.assign(node.dataset, v);
    else if (k.startsWith("on") && typeof v === "function") {
      node.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (k === "html") {
      node.innerHTML = v;
    } else if (k in node) {
      try { node[k] = v; } catch { node.setAttribute(k, v); }
    } else {
      node.setAttribute(k, v);
    }
  }
  const list = Array.isArray(children) ? children : [children];
  for (const c of list) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) {
      c.forEach(sub => sub != null && sub !== false && node.append(sub));
    } else if (c instanceof Node) {
      node.append(c);
    } else {
      node.append(document.createTextNode(String(c)));
    }
  }
  return node;
}

export function clear(node) {
  while (node && node.firstChild) node.removeChild(node.firstChild);
}

// Numbers are coerced to strings by the DOM at runtime, but the lib.dom
// `setAttribute(name, value: string)` signature is strictly typed. SVG-heavy
// drawing code uses raw numbers everywhere; this tiny helper keeps those
// call sites short and typecheck-clean.
export function setAttr(elt, name, value) {
  elt.setAttribute(name, String(value));
}

// Selectors for "looks like a button but isn't" — applied uniformly via
// a delegated handler installed by `installRowKeyboardHandlers()`.
// Keeping this list central means screens don't have to repeat keyboard
// wiring.
//
// UX-E note: this is now a SAFETY NET, not a load-bearing default. We
// removed `.activity-row[onclick]` from the selector because nothing in
// the codebase sets the inline `onclick` HTML attribute — every
// click-handler in `el(... { onClick })` goes through `addEventListener`
// at the JS level, so the `[onclick]` attribute selector never matched.
// The remaining entries cover the genuinely-can't-be-a-button cases:
//   * `tr.row-clickable` — `<tr>` can't be a `<button>`, so we keep the
//     observer for the few clickable table rows.
//   * `.kanban-card` — the wrapper is `draggable`; using `<button>` for a
//     drag handle is inconsistent across browsers, so the workBoard
//     keeps a `<div>`.
//   * `.activity-row.row-clickable` — explicit opt-in for any row that
//     can't be a button (e.g. legacy tr-shaped HTML inside templates).
//   * Tree items + dock items + chips + palette items + revision rows
//     are progressively migrating to real `<button>` elements; the
//     observer covers the holdouts.
//
// New screens should prefer rendering a real `<button type="button">`
// rather than relying on this observer. The observer's only job is to
// catch shapes where a button isn't structurally possible.
const ROW_BUTTON_SELECTOR = [
  ".activity-row.row-clickable",
  ".tree-item",
  ".dock-item",
  ".kanban-card",
  ".row-clickable",
  ".chip.clickable",
  ".palette-item",
  ".revision-row",
  ".uns-tree-item",
].join(",");

/**
 * Install a single delegated keydown handler that turns any element matching
 * `ROW_BUTTON_SELECTOR` into a keyboard-activatable button: focusable via
 * Tab (we set tabindex on attach), Enter/Space dispatches a synthetic
 * click. Idempotent — safe to call many times.
 */
let _rowKbInstalled = false;
export function installRowKeyboardHandlers(rootDoc = document) {
  if (_rowKbInstalled) return;
  _rowKbInstalled = true;

  // MutationObserver gives every newly-inserted row tabindex="0" + role.
  const tag = (node) => {
    if (!(node instanceof Element)) return;
    const candidates = node.matches?.(ROW_BUTTON_SELECTOR)
      ? [node]
      : node.querySelectorAll?.(ROW_BUTTON_SELECTOR) || [];
    candidates.forEach(c => {
      if (c.tagName === "A" || c.tagName === "BUTTON") return;
      if (!c.hasAttribute("tabindex")) c.setAttribute("tabindex", "0");
      if (!c.hasAttribute("role")) c.setAttribute("role", "button");
    });
  };
  tag(rootDoc.body);

  const mo = new MutationObserver((muts) => {
    for (const m of muts) {
      m.addedNodes.forEach(tag);
    }
  });
  mo.observe(rootDoc.body, { childList: true, subtree: true });

  rootDoc.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const target = e.target;
    if (!(target instanceof HTMLElement)) return;
    if (!target.matches(ROW_BUTTON_SELECTOR)) return;
    // Skip if the focus is on a real button/input inside the row.
    if (target !== rootDoc.activeElement) return;
    e.preventDefault();
    target.click();
  });
}

/**
 * Make a non-button element behave like a button for keyboard users.
 * Adds `role="button"`, `tabindex="0"`, and Enter/Space activation. Pointer
 * `onClick` is preserved verbatim. Use this when a real `<button>`/`<a>`
 * isn't structurally possible (e.g. table rows, list rows in a tree).
 */
export function clickable(node, onActivate, opts = {}) {
  if (!node || typeof onActivate !== "function") return node;
  if (!node.hasAttribute("role")) node.setAttribute("role", "button");
  if (!node.hasAttribute("tabindex")) node.setAttribute("tabindex", "0");
  if (opts.label && !node.hasAttribute("aria-label")) node.setAttribute("aria-label", opts.label);
  node.addEventListener("keydown", (e) => {
    // Enter activates immediately; Space prevents page-scroll and acts on keyup.
    if (e.key === "Enter") {
      e.preventDefault();
      onActivate(e);
    } else if (e.key === " ") {
      e.preventDefault();
    }
  });
  node.addEventListener("keyup", (e) => {
    if (e.key === " ") { e.preventDefault(); onActivate(e); }
  });
  return node;
}

export function mount(node, content) {
  clear(node);
  if (Array.isArray(content)) content.forEach(c => c && node.append(c));
  else if (content) node.append(content);
}

export function badge(label, variant = "", opts = {}) {
  return el("span", { class: `badge ${variant}`.trim(), ...opts }, [label]);
}

export function chip(label, opts = {}) {
  const { kind, onClick } = opts;
  const node = el(
    "span",
    { class: `chip${onClick ? " clickable" : ""}`, onClick },
    [kind ? el("span", { class: "chip-kind" }, [kind]) : null, label]
  );
  if (onClick) clickable(node, onClick);
  return node;
}

export function kpi(label, value, delta, deltaDir) {
  return el("div", { class: "kpi" }, [
    el("div", { class: "kpi-label" }, [label]),
    el("div", { class: "kpi-value" }, [value]),
    delta ? el("div", { class: `kpi-delta ${deltaDir || ""}` }, [delta]) : null,
  ]);
}

export function card(title, body, opts = {}) {
  const { actions, subtitle } = opts;
  return el("section", { class: "card" }, [
    (title || actions) && el("header", { class: "card-header" }, [
      el("div", {}, [
        title ? el("h3", {}, [title]) : null,
        subtitle ? el("div", { class: "card-subtitle" }, [subtitle]) : null,
      ]),
      actions ? el("div", { class: "row" }, actions) : null,
    ]),
    body,
  ]);
}

export function table({ columns = [], rows = [], onRowClick = null } = {}) {
  const t = el("table", { class: "table" }, [
    el("thead", {}, [
      el("tr", {}, columns.map(c => el("th", {}, [c.header || c.key]))),
    ]),
    el("tbody", {},
      rows.map(row => {
        const tr = el(
          "tr",
          {
            class: onRowClick ? "row-clickable" : "",
            onClick: onRowClick ? () => onRowClick(row) : null,
          },
          columns.map(c => {
            const val = c.render ? c.render(row) : row[c.key];
            const cell = el("td", {});
            if (val instanceof Node) cell.append(val);
            else if (Array.isArray(val)) val.forEach(v => v != null && cell.append(v instanceof Node ? v : document.createTextNode(String(v))));
            else if (val != null) cell.append(document.createTextNode(String(val)));
            return cell;
          })
        );
        if (onRowClick) clickable(tr, () => onRowClick(row));
        return tr;
      })
    ),
  ]);
  return t;
}

// Variant-specific auto-dismiss timeouts (UX-D). Successes flash by;
// warnings linger; errors stay long enough to read + react. Operators
// can opt into a sticky toast for unrecoverable failures via the
// `sticky: true` option below.
const TOAST_DEFAULT_TIMEOUTS = {
  "":        2800,
  info:      2800,
  success:   2800,
  warn:      5000,
  danger:    8000,
};

/**
 * Surface a transient message in the bottom-right toast stack.
 *
 * Backwards-compatible call shape: `toast("Saved", "success")` still
 * works. The third argument is an options bag that adds:
 *
 *   • `action`    `{ label, onClick }`. Renders an inline button
 *                 inside the toast; clicking it runs `onClick()` and
 *                 dismisses. Useful for "Undo" / "Retry" patterns.
 *   • `sticky`    `true` to disable auto-dismiss. The user must click
 *                 the close (✕) button to dismiss. Reserved for
 *                 unrecoverable errors.
 *   • `timeout`   override the variant-specific default in ms.
 *
 * Behaviour additions (UX-D):
 *   - Manual dismiss via a close button on every toast (a11y
 *     requirement: a sticky `aria-live` region must be dismissible).
 *   - Hover-pause: the auto-dismiss timer pauses while the pointer
 *     or focus is on the toast, so a user reading a long message
 *     isn't cut off.
 *   - Variant-specific timeouts (info/success 2.8 s, warn 5 s,
 *     danger 8 s); see `TOAST_DEFAULT_TIMEOUTS`.
 *
 * Returns a `{ close }` handle the caller can use to dismiss
 * programmatically (e.g. when the action it surfaced succeeds).
 */
export function toast(message, variant = "", opts = {}) {
  const root = document.getElementById("toastRoot");
  if (!root) return { close: () => {} };
  if (message == null || String(message).trim() === "") return { close: () => {} };

  const { action = null, sticky = false } = opts || {};
  const timeoutMs = sticky
    ? null
    : (opts?.timeout != null ? opts.timeout : (TOAST_DEFAULT_TIMEOUTS[variant] ?? TOAST_DEFAULT_TIMEOUTS[""]));

  // Two-phase removal: opacity to 0 (fast) → DOM removal so the next
  // toast in the stack reflows in cleanly.
  let removed = false;
  let dismissTimer = null;
  let removeTimer = null;
  const close = () => {
    if (removed) return;
    removed = true;
    if (dismissTimer) { clearTimeout(dismissTimer); dismissTimer = null; }
    node.style.transition = "opacity 200ms ease";
    node.style.opacity = "0";
    removeTimer = setTimeout(() => node.remove(), 220);
  };

  const closeBtn = el("button", {
    class: "toast-close",
    type: "button",
    "aria-label": "Dismiss notification",
    onClick: () => { close(); },
  }, ["✕"]);

  const actionBtn = action && action.label && typeof action.onClick === "function"
    ? el("button", {
        class: "toast-action",
        type: "button",
        onClick: () => {
          try { action.onClick(); } finally { close(); }
        },
      }, [action.label])
    : null;

  const node = el("div", {
    class: `toast ${variant}${sticky ? " sticky" : ""}`.trim(),
    role: variant === "danger" ? "alert" : "status",
  }, [
    el("div", { class: "toast-message" }, [message]),
    actionBtn,
    closeBtn,
  ]);

  // Hover/focus-pause: clear the auto-dismiss timer while the user
  // is interacting; restart when they leave. Sticky toasts have no
  // timer so the listeners are no-ops.
  if (timeoutMs != null) {
    const start = () => {
      if (removed || dismissTimer) return;
      dismissTimer = setTimeout(close, timeoutMs);
    };
    const pause = () => {
      if (dismissTimer) { clearTimeout(dismissTimer); dismissTimer = null; }
    };
    node.addEventListener("mouseenter", pause);
    node.addEventListener("mouseleave", start);
    node.addEventListener("focusin", pause);
    node.addEventListener("focusout", start);
    start();
  }

  root.append(node);
  return { close };
}

export function modal({ title = "", body = null, actions = null } = {}) {
  const root = document.getElementById("modalRoot");
  if (!root) return { close: () => {} };

  const previouslyFocused = /** @type {HTMLElement | null} */ (document.activeElement);
  const close = () => {
    root.innerHTML = "";
    if (previouslyFocused && typeof previouslyFocused.focus === "function") {
      try { previouslyFocused.focus(); } catch { /* noop */ }
    }
  };

  const backdrop = el("div", {
    class: "modal-backdrop",
    onClick: (e) => { if (e.target === backdrop) close(); },
    onKeydown: (e) => {
      if (e.key === "Escape") { e.preventDefault(); close(); return; }
      if (e.key !== "Tab") return;
      // Trap focus within the modal.
      const focusables = /** @type {NodeListOf<HTMLElement>} */ (backdrop.querySelectorAll("button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])"));
      const first = focusables[0]; const last = focusables[focusables.length - 1];
      if (!first) return;
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    },
  }, [
    el("div", {
      class: "modal",
      role: "dialog",
      "aria-modal": "true",
      "aria-label": title || "Dialog",
    }, [
      el("div", { class: "modal-header" }, [
        el("h3", { id: "modal-title" }, [title || ""]),
        el("button", { class: "btn ghost sm", onClick: close, "aria-label": "Close dialog" }, ["Close"]),
      ]),
      el("div", { class: "modal-body" }, [body]),
      actions && actions.length
        ? el("div", { class: "modal-footer" }, actions.map(a => a.node ? a.node : el("button", {
            class: `btn ${a.variant || ""}`.trim(),
            onClick: () => {
              if (a.onClick && a.onClick() === false) return;
              close();
            },
          }, [a.label])))
        : null,
    ]),
  ]);

  root.innerHTML = "";
  root.append(backdrop);
  // Focus the first focusable element. Prefer body fields, then the primary
  // footer button, and only fall back to the header Close button if the
  // dialog has nothing else (which should be unusual).
  setTimeout(() => {
    const body = backdrop.querySelector(".modal-body");
    const footer = backdrop.querySelector(".modal-footer");
    const candidates = [
      body && body.querySelector("input, select, textarea, button:not(.ghost), [tabindex]:not([tabindex='-1'])"),
      footer && footer.querySelector("button.primary, button:not(.ghost), button"),
      backdrop.querySelector("button:not(.ghost)"),
      backdrop.querySelector("button"),
    ].filter(Boolean);
    const first = /** @type {HTMLElement | undefined} */ (candidates[0]);
    if (first) try { first.focus(); } catch {}
  }, 0);
  return { close };
}

export function drawer({ title = "", subtitle = "", body = null, actions = null, width = "520px" } = {}) {
  const root = document.getElementById("modalRoot");
  if (!root) return { close: () => {} };

  const previouslyFocused = /** @type {HTMLElement | null} */ (document.activeElement);
  const close = () => {
    root.innerHTML = "";
    if (previouslyFocused && typeof previouslyFocused.focus === "function") {
      try { previouslyFocused.focus(); } catch { /* noop */ }
    }
  };

  const backdrop = el("div", {
    class: "drawer-backdrop",
    onClick: (e) => { if (e.target === backdrop) close(); },
    onKeydown: (e) => {
      if (e.key === "Escape") { e.preventDefault(); close(); return; }
      if (e.key !== "Tab") return;
      const focusables = /** @type {NodeListOf<HTMLElement>} */ (backdrop.querySelectorAll("button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])"));
      const first = focusables[0]; const last = focusables[focusables.length - 1];
      if (!first) return;
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    },
  }, [
    el("aside", {
      class: "drawer-panel",
      role: "dialog",
      "aria-modal": "true",
      "aria-label": title || "Details",
      style: { width },
    }, [
      el("div", { class: "drawer-header" }, [
        el("div", {}, [
          title ? el("h3", {}, [title]) : null,
          subtitle ? el("div", { class: "tiny muted" }, [subtitle]) : null,
        ]),
        el("button", { class: "btn ghost sm", onClick: close, "aria-label": "Close details" }, ["Close"]),
      ]),
      el("div", { class: "drawer-body" }, [body]),
      actions?.length ? el("div", { class: "drawer-footer" }, actions.map(a => a.node ? a.node : el("button", {
        class: `btn ${a.variant || ""}`.trim(),
        onClick: () => {
          if (a.onClick && a.onClick() === false) return;
          close();
        },
      }, [a.label]))) : null,
    ]),
  ]);

  root.innerHTML = "";
  root.append(backdrop);
  setTimeout(() => {
    const first = backdrop.querySelector("button:not(.ghost), input, select, textarea, button");
    if (first) try { first.focus(); } catch {}
  }, 0);
  return { close };
}

export function confirm({ title = "Confirm", message = "", confirmLabel = "Confirm", variant = "primary" } = {}) {
  return new Promise((resolve) => {
    modal({
      title,
      body: el("p", { class: "muted" }, [message || "Are you sure?"]),
      actions: [
        { label: "Cancel", onClick: () => { resolve(false); } },
        { label: confirmLabel, variant, onClick: () => { resolve(true); } },
      ],
    });
  });
}

/**
 * Styled replacement for `window.prompt`. Resolves with the entered string,
 * or `null` if the user cancels. Always returns a Promise.
 */
export function prompt({ title = "Enter value", message = "", defaultValue = "", placeholder = "", confirmLabel = "OK", inputType = "text" } = {}) {
  return new Promise((resolve) => {
    const inp = input({ value: defaultValue, placeholder, type: inputType });
    let resolved = false;
    const finish = (value) => {
      if (resolved) return;
      resolved = true;
      resolve(value);
    };
    inp.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        finish(inp.value);
        // Close the modal — find the backdrop and clear it.
        const root = document.getElementById("modalRoot");
        if (root) root.innerHTML = "";
      }
    });
    modal({
      title,
      body: el("div", { class: "stack" }, [
        message ? el("p", { class: "muted" }, [message]) : null,
        formRow(title, inp),
      ]),
      actions: [
        { label: "Cancel", onClick: () => finish(null) },
        { label: confirmLabel, variant: "primary", onClick: () => finish(inp.value) },
      ],
    });
    setTimeout(() => { try { inp.focus(); inp.select?.(); } catch {} }, 0);
  });
}

let _formRowSeq = 0;
/**
 * Pair a `<label>` with a control via id/htmlFor so clicking the label
 * focuses the input and AT announces them as one. If the control already
 * has an `id`, that id is reused; otherwise a unique one is generated.
 */
export function formRow(label, control) {
  const id = control && control.id ? control.id : `fr-${++_formRowSeq}`;
  if (control && !control.id) control.id = id;
  return el("div", { class: "form-row" }, [
    el("label", { htmlFor: id }, [label]),
    control,
  ]);
}

export function input(props = {}) {
  return el("input", { class: "input", ...props });
}

export function select(options, props = {}) {
  const s = el("select", { class: "select", ...props });
  options.forEach(o => {
    const v = typeof o === "object" ? o.value : o;
    const t = typeof o === "object" ? o.label : o;
    const opt = document.createElement("option");
    opt.value = v;
    opt.textContent = t;
    s.append(opt);
  });
  if (props.value != null) s.value = props.value;
  return s;
}

export function textarea(props = {}) {
  return el("textarea", { class: "textarea", ...props });
}

// Free-form input backed by a `<datalist>` for autocomplete suggestions.
// Returns a wrapper element (`<span class="input-wrap">`) containing the
// `<input>` + the `<datalist>`; access the `<input>` via `.input`.
//
// Pattern: callers want users to be able to TYPE a new value (datalist
// allows that — unlike `<select>`) but also browse / pick from values
// that already exist in the workspace. Uses native browser autocomplete
// so it stays accessible and lightweight (no popover machinery).
let _datalistSeq = 0;
export function inputWithSuggestions(suggestions = [], props = {}) {
  const id = `dl-${++_datalistSeq}`;
  const dedup = Array.from(new Set((suggestions || []).filter(s => s != null && String(s).trim() !== "")));
  dedup.sort((a, b) => String(a).localeCompare(String(b)));
  const inp = el("input", { class: "input", list: id, ...props });
  const dl = el("datalist", { id });
  for (const s of dedup) {
    const opt = document.createElement("option");
    opt.value = String(s);
    dl.append(opt);
  }
  const wrap = el("span", { class: "input-wrap", style: { display: "block", position: "relative" } }, [inp, dl]);
  /** @type {any} */ (wrap).input = inp;
  return wrap;
}

// Tabs primitive — single source of truth for tab strips. Persists the
// active tab in sessionStorage when `sessionKey` is provided.
//
// Usage:
//   tabs({
//     tabs: [{ id: "summary", label: "Summary", content: () => node },
//            { id: "data", label: "Data 5", content: () => node }],
//     sessionKey: "asset.context.AS-1",
//     ariaLabel: "Asset context",
//     onChange: (id) => {},
//   })
export function tabs({ tabs: list = [], sessionKey = "", ariaLabel = "", defaultId = "", onChange = null } = {}) {
  const stored = sessionKey ? sessionStorage.getItem(sessionKey) : null;
  const active = list.find(t => t.id === stored)
    || list.find(t => t.id === defaultId)
    || list[0];
  const tablist = el("div", { class: "context-tabs", role: "tablist", "aria-label": ariaLabel || "Tabs" });
  const panel = el("div", { class: "context-tab-panel", role: "tabpanel" });

  function pick(t) {
    if (sessionKey) sessionStorage.setItem(sessionKey, t.id);
    if (onChange) onChange(t.id);
    render();
  }

  function render() {
    const cur = list.find(t => t.id === (sessionKey ? sessionStorage.getItem(sessionKey) : null))
      || active || list[0];
    tablist.innerHTML = "";
    list.forEach((t, i) => {
      const isActive = t.id === cur.id;
      const btn = el("button", {
        class: `context-tab ${isActive ? "active" : ""}`,
        role: "tab",
        type: "button",
        "aria-selected": String(isActive),
        tabindex: isActive ? "0" : "-1",
        id: `tab-${t.id}`,
        "aria-controls": `tabpanel-${t.id}`,
        onClick: () => pick(t),
        onKeydown: (e) => {
          if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
            e.preventDefault();
            const dir = e.key === "ArrowRight" ? 1 : -1;
            const next = list[(i + dir + list.length) % list.length];
            pick(next);
            const nb = tablist.querySelector(`#tab-${next.id}`);
            if (nb) nb.focus();
          } else if (e.key === "Home") {
            e.preventDefault(); pick(list[0]);
            tablist.querySelector(`#tab-${list[0].id}`)?.focus();
          } else if (e.key === "End") {
            e.preventDefault(); pick(list[list.length - 1]);
            tablist.querySelector(`#tab-${list[list.length - 1].id}`)?.focus();
          }
        },
      }, [t.label]);
      tablist.append(btn);
    });
    panel.innerHTML = "";
    panel.id = `tabpanel-${cur.id}`;
    panel.setAttribute("aria-labelledby", `tab-${cur.id}`);
    const c = typeof cur.content === "function" ? cur.content() : cur.content;
    if (c instanceof Node) panel.append(c);
    else if (Array.isArray(c)) c.forEach(x => x && panel.append(x));
    else if (c != null) panel.append(document.createTextNode(String(c)));
  }
  render();
  return el("section", { class: "tabs-wrap" }, [tablist, panel]);
}

// ─────────────────────────────────────────────────────────────────
// State primitives (UX-D).
// ─────────────────────────────────────────────────────────────────
//
// Three universal "this is what's happening" surfaces — loading,
// empty, error — plus a `skeleton()` shimmer for richer pre-data
// placeholders. Every primitive carries the right ARIA: loading is
// `role="status" aria-busy="true"`, empty is informational, error
// is `role="alert"`. Shape stays small + composable so screens can
// drop them into any container.
//
// Why this matters: pre-UX-D, twelve screens hand-rolled a
// `<div class="muted tiny">Loading…</div>` each — different copy,
// different ARIA (none), different visual. Centralising the
// vocabulary means a screen-reader user hears "Loading enterprise
// list, busy" instead of silence, and the visual treatment is
// tunable in one place.

/**
 * Loading state. Renders a centred spinner + label.
 *
 * @param {Object} [opts]
 * @param {string} [opts.message] visible label (default "Loading...").
 * @param {"sm"|"md"|"lg"} [opts.size] spinner size (default "md").
 * @param {boolean} [opts.compact] true for inline pill (no centered
 *   min-height padding), suitable for embedding inside table cells
 *   or card headers (default false).
 */
export function loadingState({ message = "Loading…", size = "md", compact = false } = {}) {
  return el("div", {
    class: `state-loading state-loading-${size}${compact ? " compact" : ""}`,
    role: "status",
    "aria-busy": "true",
    "aria-live": "polite",
  }, [
    el("span", { class: "state-spinner", "aria-hidden": "true" }),
    el("span", { class: "state-loading-label" }, [message]),
  ]);
}

/**
 * Empty state. "You have no data here yet" surface with an optional
 * inline call-to-action button.
 *
 * @param {Object} [opts]
 * @param {string|null} [opts.icon] small glyph in the header (decorative,
 *   aria-hidden). Default "package" emoji. Pass `null` to omit.
 * @param {string} [opts.title] short noun phrase. Required in practice
 *   to render anything meaningful, but typed optional so a programmatic
 *   `emptyState()` call doesn't blow up the type-checker.
 * @param {string|Node} [opts.message] supporting copy.
 * @param {{ label: string, onClick: Function, variant?: string }} [opts.action]
 *   primary CTA. Variant defaults to "primary".
 */
export function emptyState({ icon = "📦", title = "", message = "", action = null } = {}) {
  return el("div", { class: "state-empty", role: "status" }, [
    icon ? el("div", { class: "state-icon", "aria-hidden": "true" }, [icon]) : null,
    title ? el("div", { class: "state-title" }, [title]) : null,
    message ? el("div", { class: "state-message" }, [message]) : null,
    action && action.label && typeof action.onClick === "function"
      ? el("button", {
          class: `btn ${action.variant || "primary"}`.trim(),
          type: "button",
          onClick: () => action.onClick(),
        }, [action.label])
      : null,
  ]);
}

/**
 * Error state. Operation failed, recoverable or not. Uses
 * `role="alert"` so AT announces immediately on insertion. Pairs
 * a clear title + the technical detail (which can be a string or a
 * pre-built Node, e.g. a stack trace) + a Retry button slot.
 *
 * @param {Object} [opts]
 * @param {string} [opts.title] short headline. Typed optional so a
 *   programmatic `errorState()` call passes the type-checker, but
 *   callers should always supply one.
 * @param {string|Node} [opts.message] technical detail / error message.
 * @param {{ label: string, onClick: Function, variant?: string }} [opts.action]
 *   typically `{ label: "Retry", onClick: refetch }`.
 */
export function errorState({ title = "", message = "", action = null } = {}) {
  return el("div", { class: "state-error", role: "alert" }, [
    el("div", { class: "state-icon state-icon-danger", "aria-hidden": "true" }, ["⚠"]),
    title ? el("div", { class: "state-title" }, [title]) : null,
    message ? el("div", { class: "state-message" }, [message]) : null,
    action && action.label && typeof action.onClick === "function"
      ? el("button", {
          class: `btn ${action.variant || "primary"}`.trim(),
          type: "button",
          onClick: () => action.onClick(),
        }, [action.label])
      : null,
  ]);
}

/**
 * Skeleton placeholder. Shimmer-pulsed bars / cards while real data
 * loads. Use when the eventual layout is known + bounded enough that
 * showing the shape reduces perceived latency more than a spinner.
 *
 * @param {Object} [opts]
 * @param {"lines"|"table"|"card"} [opts.kind] visual shape (default
 *   "lines"). `lines` is N stacked bars of varying widths; `table`
 *   is one bar per row at full width; `card` is one rounded
 *   rectangle the size of a card.
 * @param {number} [opts.rows] number of placeholder rows (default 3).
 */
export function skeleton({ kind = "lines", rows = 3 } = {}) {
  if (kind === "card") {
    return el("div", { class: "skeleton skeleton-card", "aria-hidden": "true" });
  }
  const bars = [];
  // Vary widths so the placeholder doesn't look like a column of
  // identical bars — closer to real text proportions.
  const widths = ["100%", "92%", "78%", "85%", "70%", "95%", "88%"];
  for (let i = 0; i < rows; i++) {
    const w = kind === "table" ? "100%" : widths[i % widths.length];
    bars.push(el("div", {
      class: `skeleton skeleton-${kind === "table" ? "table-row" : "line"}`,
      style: { width: w },
    }));
  }
  return el("div", { class: "skeleton-wrap", "aria-hidden": "true" }, bars);
}
