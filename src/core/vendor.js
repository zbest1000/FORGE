// Dynamic loader for third-party OSS modules.
//
// Rationale: the prototype keeps `python3 -m http.server` as its run command
// and has no bundler. Third-party code is therefore loaded at runtime from
// the import map declared in `index.html`. If any load fails — offline,
// blocked, or unavailable — callers fall back to their hand-rolled
// equivalent. Failures are logged to the audit ledger so reviewers can see
// which features degraded.
//
// Every loader is memoised so the module is only fetched once.

// Deliberately no dependency on core/audit here — writing audit entries for
// vendor failures triggers a feedback loop because audit writes go through
// IndexedDB, which probes Dexie via this loader. Failures are logged to the
// console instead; the caller's own fallback path takes over.

const cache = new Map();
const loadedOk = new Set();
const loadedFail = new Set();

// Vite can statically discover these import targets and include them in the
// production build. In direct-source dev mode the import map in index.html
// resolves the same specifiers.
const loaders = {
  minisearch: () => import("minisearch"),
  dexie: () => import("dexie"),
  marked: () => import("marked"),
  dompurify: () => import("dompurify"),
  mermaid: () => import("mermaid"),
  "svg-pan-zoom": () => import("svg-pan-zoom"),
  uplot: () => import("uplot"),
  echarts: () => import("echarts"),
  mqtt: () => import("mqtt"),
  "web-ifc": () => import("web-ifc"),
  "fuse.js": () => import("fuse.js"),
  "date-fns": () => import("date-fns"),
  "pdfjs-dist": () => import("pdfjs-dist"),
  papaparse: () => import("papaparse"),
  three: () => import("three"),
  "dxf-viewer": () => import("dxf-viewer"),
  "online-3d-viewer": () => import("online-3d-viewer"),
  rapidoc: () => import("rapidoc"),
};

function load(spec, name, probe) {
  if (cache.has(name)) return cache.get(name);
  const loader = loaders[spec] || (() => import(/* @vite-ignore */ spec));
  const p = loader()
    .then(mod => {
      const v = probe ? probe(mod) : mod;
      if (!loadedOk.has(name)) {
        loadedOk.add(name);
        try { console.info("[vendor] loaded", name); } catch {}
      }
      return v;
    })
    .catch(err => {
      if (!loadedFail.has(name)) {
        loadedFail.add(name);
        try { console.warn("[vendor] load failed:", name, err?.message || err); } catch {}
      }
      cache.delete(name); // allow retry on next access
      throw err;
    });
  cache.set(name, p);
  return p;
}

/** Observable state — callers can render a badge in the UI if they wish. */
export function vendorStatus() {
  return { loaded: [...loadedOk], failed: [...loadedFail] };
}

export const vendor = {
  minisearch:  () => load("minisearch",   "minisearch",  m => m.default || m.MiniSearch || m),
  dexie:       () => load("dexie",        "dexie",       m => m.default || m.Dexie     || m),
  marked:      () => load("marked",       "marked",      m => (m.marked || m.default || m)),
  dompurify:   () => load("dompurify",    "dompurify",   m => (m.default || m)),
  mermaid:     () => load("mermaid",      "mermaid",     m => (m.default || m)),
  svgPanZoom:  () => load("svg-pan-zoom", "svg-pan-zoom",m => (m.default || m)),
  uplot:       () => load("uplot",        "uplot",       m => (m.default || m)),
  echarts:     () => load("echarts",      "echarts",     m => (m.default || m)),
  mqtt:        () => load("mqtt",         "mqtt",        m => (m.default || m)),
  webIfc:      () => load("web-ifc",      "web-ifc",     m => m),
  fuse:        () => load("fuse.js",      "fuse.js",     m => (m.default || m.Fuse || m)),
  dateFns:     () => load("date-fns",     "date-fns",    m => m),
  pdfjs:       () => load("pdfjs-dist",   "pdfjs-dist",  m => (m.GlobalWorkerOptions ? m : (m.default || m))),
  papaparse:   () => load("papaparse",    "papaparse",   m => (m.default || m)),
  three:       () => load("three",        "three",       m => m),
  dxfViewer:   () => load("dxf-viewer",   "dxf-viewer",  m => m),
  online3d:    () => load("online-3d-viewer", "online-3d-viewer", m => m),
  rapidoc:     () => load("rapidoc",      "rapidoc",     m => (m.default || m)),
};

/**
 * Try to load a vendor module; invoke `useLib(lib)` on success, or
 * `fallback()` on failure. Returns whatever the called function returns.
 */
export async function withVendor(name, useLib, fallback) {
  try {
    const lib = await vendor[name]();
    return await useLib(lib);
  } catch {
    return fallback ? fallback() : null;
  }
}
