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

export function badge(label, variant = "") {
  return el("span", { class: `badge ${variant}`.trim() }, [label]);
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
