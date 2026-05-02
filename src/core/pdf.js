// PDF.js (Apache 2.0) wrapper. Loads on demand, sets the worker URL to a
// locally-bundled file (Vite emits it into /assets via `?url`), and
// renders pages into canvas elements.
//
// Why local-bundled instead of an esm.sh CDN URL: the CDN dependency
// breaks under strict CSP, in air-gapped deploys, and any time the CDN
// itself is slow / down. The `?url` Vite import makes pdfjs's worker
// part of the bundle the rest of the app already trusts.

import { vendor } from "./vendor.js";
// Vite resolves this to a hashed asset URL; pdfjs spawns a Worker against
// it. In source-mode dev (no Vite bundling), the import map maps
// pdfjs-dist to esm.sh, and we fall back to that worker URL below.
// `?url` is a Vite suffix; tsc has no first-class understanding of it
// (no @types/vite asset-suffix declaration ships by default), so we
// suppress the resolution error here. The runtime behaviour is fine.
// @ts-ignore — Vite asset-URL import
import workerUrl from "pdfjs-dist/build/pdf.worker.mjs?url";

let _pdfjs = null;
async function ensure() {
  if (_pdfjs) return _pdfjs;
  try {
    const lib = await vendor.pdfjs();
    if (!lib) return null;
    if (lib.GlobalWorkerOptions && !lib.GlobalWorkerOptions.workerSrc) {
      // Prefer the bundled worker URL. If the import resolves to a falsy
      // value (e.g. source-mode dev where Vite isn't transforming this
      // file), fall through to the pinned esm.sh worker so the viewer
      // still works.
      lib.GlobalWorkerOptions.workerSrc = workerUrl
        || "https://esm.sh/pdfjs-dist@4.6.82/build/pdf.worker.min.mjs";
    }
    _pdfjs = lib;
    return lib;
  } catch { return null; }
}

export async function openPdf(url) {
  const pdfjs = await ensure();
  if (!pdfjs) return null;
  // PDF.js's worker fetches the URL itself by default. That works for
  // ordinary HTTP(S) URLs, but `blob:` URLs created by `URL.createObjectURL`
  // can fail inside the worker context with "Unexpected server response
  // (0) while retrieving PDF" — the blob was registered against the main
  // window's URL store and the worker can't see it. Same hazard with
  // `data:` URLs over a certain size on some browsers.
  //
  // Workaround: read the bytes ourselves on the main thread and hand the
  // ArrayBuffer to pdfjs via `data`, which sidesteps the worker fetch.
  const isLocal = typeof url === "string" && (url.startsWith("blob:") || url.startsWith("data:"));
  if (isLocal) {
    const resp = await fetch(url);
    if (!resp.ok && resp.status !== 0) {
      throw new Error(`Failed to fetch local PDF (${resp.status})`);
    }
    const buf = await resp.arrayBuffer();
    const loading = pdfjs.getDocument({ data: new Uint8Array(buf) });
    return loading.promise;
  }
  const loading = pdfjs.getDocument({ url });
  return loading.promise;
}

export async function renderPage(pdf, pageNumber, container, opts = {}) {
  const page = await pdf.getPage(pageNumber);
  const viewport = page.getViewport({ scale: opts.scale || 1.25 });
  const canvas = document.createElement("canvas");
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  canvas.style.width = "100%";
  canvas.style.maxWidth = "720px";
  canvas.style.height = "auto";
  canvas.style.background = "#fff";
  canvas.style.border = "1px solid var(--border)";
  canvas.style.borderRadius = "6px";
  container.replaceChildren(canvas);
  const ctx = canvas.getContext("2d");
  await page.render({ canvasContext: ctx, viewport }).promise;
  return canvas;
}
