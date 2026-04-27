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

// Selectors for "looks like a button but isn't" — applied uniformly via
// a delegated handler installed by `installRowKeyboardHandlers()`. Keeping
// this list central means screens don't have to repeat keyboard wiring.
const ROW_BUTTON_SELECTOR = [
  ".activity-row[onclick]",
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
    if (!(target instanceof Element)) return;
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

export function table({ columns, rows, onRowClick }) {
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

export function toast(message, variant = "") {
  const root = document.getElementById("toastRoot");
  if (!root) return;
  if (message == null || String(message).trim() === "") return;
  const node = el("div", { class: `toast ${variant}`.trim() }, [message]);
  root.append(node);
  setTimeout(() => {
    node.style.transition = "opacity 0.3s ease";
    node.style.opacity = "0";
    setTimeout(() => node.remove(), 300);
  }, 2800);
}

export function modal({ title, body, actions }) {
  const root = document.getElementById("modalRoot");
  if (!root) return { close: () => {} };

  const previouslyFocused = document.activeElement;
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
      const focusables = backdrop.querySelectorAll("button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])");
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
    const first = candidates[0];
    if (first) try { first.focus(); } catch {}
  }, 0);
  return { close };
}

export function drawer({ title, subtitle, body, actions, width = "520px" } = {}) {
  const root = document.getElementById("modalRoot");
  if (!root) return { close: () => {} };

  const previouslyFocused = document.activeElement;
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
      const focusables = backdrop.querySelectorAll("button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])");
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

export function confirm({ title = "Confirm", message, confirmLabel = "Confirm", variant = "primary" } = {}) {
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
export function prompt({ title = "Enter value", message, defaultValue = "", placeholder = "", confirmLabel = "OK", inputType = "text" } = {}) {
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
