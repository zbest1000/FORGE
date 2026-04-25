// PDF.js (Apache 2.0) wrapper. Loads on demand, sets the worker URL to the
// same pinned version that the import map resolves, and renders pages into
// canvas elements.

import { vendor } from "./vendor.js";

let _pdfjs = null;
async function ensure() {
  if (_pdfjs) return _pdfjs;
  try {
    const lib = await vendor.pdfjs();
    if (!lib) return null;
    // Worker URL — same pinned version.
    if (lib.GlobalWorkerOptions && !lib.GlobalWorkerOptions.workerSrc) {
      lib.GlobalWorkerOptions.workerSrc = "https://esm.sh/pdfjs-dist@4.6.82/build/pdf.worker.min.mjs";
    }
    _pdfjs = lib;
    return lib;
  } catch { return null; }
}

export async function openPdf(url) {
  const pdfjs = await ensure();
  if (!pdfjs) return null;
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
