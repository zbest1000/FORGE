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
      rows.map(row =>
        el(
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
        )
      )
    ),
  ]);
  return t;
}

export function toast(message, variant = "") {
  const root = document.getElementById("toastRoot");
  if (!root) return;
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
  // Focus the first focusable element.
  setTimeout(() => {
    const first = backdrop.querySelector("button:not(.ghost), input, select, textarea, button");
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

// dangerAction — high-stakes confirm with extra context. Returns a Promise
// resolving to true (confirmed) or false (cancelled).
export function dangerAction({
  title = "Confirm action",
  message,
  body,
  confirmLabel = "Confirm",
  variant = "danger",
  details,
} = {}) {
  return new Promise((resolve) => {
    let resolved = false;
    const finish = (v) => { if (resolved) return; resolved = true; resolve(v); };
    modal({
      title,
      body: el("div", { class: "stack" }, [
        message ? el("p", { class: "small" }, [message]) : null,
        body ? body : null,
        details
          ? el("div", { class: "tiny muted" }, [details])
          : null,
      ]),
      actions: [
        { label: "Cancel", onClick: () => finish(false) },
        { label: confirmLabel, variant, onClick: () => finish(true) },
      ],
    });
  });
}

// prompt — replaces window.prompt with a styled modal. Returns the entered
// string, or null if cancelled. Supports optional validate(value) -> string|null
// that returns an error message to show inline.
export function prompt({
  title = "Enter a value",
  label = "Value",
  defaultValue = "",
  placeholder = "",
  multiline = false,
  helpText,
  confirmLabel = "OK",
  validate,
} = {}) {
  return new Promise((resolve) => {
    const field = multiline
      ? textarea({ value: defaultValue, placeholder })
      : input({ value: defaultValue, placeholder });
    const errLine = el("div", { class: "tiny", style: { color: "var(--danger)", display: "none" } }, [""]);
    let resolved = false;
    const finish = (v) => { if (resolved) return; resolved = true; resolve(v); };

    field.addEventListener("keydown", (e) => {
      if (!multiline && e.key === "Enter") {
        e.preventDefault();
        const v = field.value;
        const err = validate ? validate(v) : null;
        if (err) { errLine.textContent = err; errLine.style.display = "block"; return; }
        const close = field.closest(".modal-backdrop");
        if (close) close.remove();
        finish(v);
      }
    });

    modal({
      title,
      body: el("div", { class: "stack" }, [
        formRow(label, field),
        errLine,
        helpText ? el("div", { class: "tiny muted" }, [helpText]) : null,
      ]),
      actions: [
        { label: "Cancel", onClick: () => finish(null) },
        {
          label: confirmLabel,
          variant: "primary",
          onClick: () => {
            const v = field.value;
            const err = validate ? validate(v) : null;
            if (err) {
              errLine.textContent = err;
              errLine.style.display = "block";
              return false;
            }
            finish(v);
          },
        },
      ],
    });
    setTimeout(() => { try { field.focus(); field.select?.(); } catch {} }, 30);
  });
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
export function tabs({ tabs: list = [], sessionKey, ariaLabel, defaultId, onChange } = {}) {
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

// Empty state — consistent "no data" / "permission-denied" affordance.
export function emptyState({ icon, title, body, primary, secondary, hint } = {}) {
  return el("div", { class: "empty-state", role: "status" }, [
    icon ? el("div", { class: "empty-icon", "aria-hidden": "true" }, [icon]) : null,
    title ? el("div", { class: "empty-title" }, [title]) : null,
    body ? el("div", { class: "empty-body" }, [body]) : null,
    (primary || secondary) ? el("div", { class: "empty-actions row wrap" }, [
      primary ? el("button", { class: "btn primary", onClick: primary.onClick }, [primary.label]) : null,
      secondary ? el("button", { class: "btn", onClick: secondary.onClick }, [secondary.label]) : null,
    ]) : null,
    hint ? el("div", { class: "empty-hint tiny muted" }, [hint]) : null,
  ]);
}

// Page header — title + breadcrumb + status + actions row.
export function pageHeader({ title, subtitle, breadcrumbs, status, actions } = {}) {
  return el("div", { class: "page-header" }, [
    el("div", { class: "page-header-left" }, [
      breadcrumbs?.length
        ? el("div", { class: "breadcrumb tiny" }, breadcrumbs.flatMap((c, i) => {
            const seg = c.onClick
              ? el("button", { class: "crumb-link", onClick: c.onClick }, [c.label])
              : el("span", {}, [c.label]);
            return i === 0 ? [seg] : [el("span", { class: "crumb-sep", "aria-hidden": "true" }, [" / "]), seg];
          }))
        : null,
      el("div", { class: "row", style: { gap: "10px", alignItems: "center" } }, [
        title ? el("h1", { class: "page-title" }, [title]) : null,
        status ? status : null,
      ]),
      subtitle ? el("div", { class: "page-subtitle tiny muted" }, [subtitle]) : null,
    ]),
    actions?.length ? el("div", { class: "page-header-actions row wrap" }, actions) : null,
  ]);
}

export function formRow(label, input) {
  return el("div", { class: "form-row" }, [
    el("label", {}, [label]),
    input,
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
