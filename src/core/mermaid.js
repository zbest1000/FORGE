// Mermaid wrapper: renders a diagram into an element, returning the element.
// Falls back to a `<pre>` with the raw definition if Mermaid can't load.

import { vendor } from "./vendor.js";

let _initialized = false;
let _inst = null;

async function ensure() {
  if (_inst) return _inst;
  try {
    const m = await vendor.mermaid();
    const lib = m.default || m;
    if (!_initialized) {
      const theme = document.body.classList.contains("theme-light") ? "default" : "dark";
      lib.initialize({ startOnLoad: false, theme, securityLevel: "strict" });
      _initialized = true;
    }
    _inst = lib;
    return lib;
  } catch { return null; }
}

let _seq = 0;

export function renderMermaid(definition) {
  const wrap = document.createElement("div");
  wrap.className = "mermaid-wrap";
  const pre = document.createElement("pre");
  pre.className = "mono tiny";
  pre.textContent = definition;
  wrap.append(pre);
  (async () => {
    const lib = await ensure();
    if (!lib) return;
    try {
      const id = "mermaid-" + (++_seq) + "-" + Math.random().toString(36).slice(2, 6);
      const { svg } = await lib.render(id, definition);
      wrap.innerHTML = svg;
    } catch (e) {
      // keep the text fallback visible
    }
  })();
  return wrap;
}
