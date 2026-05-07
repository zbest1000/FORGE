// MIME / kind detection for the document viewer.
//
// Pulled out of docViewer.js so a future PR can extract attachPdf
// + paperPage independently — both touch detectKind / guessMime, and
// having the helpers in their own module avoids a circular import
// when those callers move into sibling files.
//
// `detectKind(url, mime?)` returns one of "pdf" | "image" | "csv" |
// null. The renderer uses this to pick which viewer pipeline to
// instantiate (PDF.js, native <img>, or the CSV parser).
//
// `guessMime(url)` is a fallback when the upload didn't carry a
// MIME type from the operating system or the asset URL doesn't
// have an HTTP response yet — sniffs the extension. Returns
// `application/octet-stream` for unknown shapes so callers don't
// have to handle null.

/**
 * @param {string | null | undefined} url
 * @param {string} [mime]
 * @returns {"pdf" | "image" | "csv" | null}
 */
export function detectKind(url, mime) {
  if (!url) return null;
  const u = String(url).toLowerCase();
  if (mime?.startsWith("image/") || /\.(png|jpe?g|svg|webp|gif)(\?|#|$)/i.test(u)) return "image";
  if (mime === "text/csv" || /\.csv(\?|#|$)/i.test(u)) return "csv";
  if (mime?.includes("pdf") || /\.pdf(\?|#|$)/i.test(u)) return "pdf";
  return null;
}

/** @param {string} url */
export function guessMime(url) {
  const u = url.toLowerCase();
  if (u.endsWith(".png")) return "image/png";
  if (u.endsWith(".jpg") || u.endsWith(".jpeg")) return "image/jpeg";
  if (u.endsWith(".svg")) return "image/svg+xml";
  if (u.endsWith(".csv")) return "text/csv";
  if (u.endsWith(".pdf")) return "application/pdf";
  return "application/octet-stream";
}
