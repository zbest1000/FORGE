// Markdown rendering helper — marked + DOMPurify. Falls back to safe plain
// text if either library is unavailable.

import { vendor } from "./vendor.js";

let _marked = null;
let _purify = null;

async function ensure() {
  if (_marked && _purify) return true;
  try {
    [_marked, _purify] = await Promise.all([vendor.marked(), vendor.dompurify()]);
    return !!(_marked && _purify);
  } catch { return false; }
}

/**
 * Render markdown to a DOM fragment. Returns a synchronous placeholder node
 * and swaps in the rendered HTML once marked/dompurify have loaded.
 */
export function renderMarkdown(source) {
  const wrap = document.createElement("div");
  wrap.className = "md";
  wrap.textContent = source || "";
  (async () => {
    const ok = await ensure();
    if (!ok) return;
    try {
      const html = _marked.parse(source || "", { gfm: true, breaks: true });
      const clean = (_purify.sanitize ? _purify.sanitize(html) : _purify(html));
      wrap.innerHTML = clean;
    } catch { /* keep plain text */ }
  })();
  return wrap;
}
