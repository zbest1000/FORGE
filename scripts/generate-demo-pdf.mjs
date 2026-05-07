// Generate a small (~3 KB) multi-page demo PDF for the doc viewer.
// Output: sample.pdf at the repo root (served as `/sample.pdf` in dev and
// production via the `copyRootStatics` Vite plugin).
//
// Why hand-rolled instead of pdfkit? Avoids a build-time dependency for a
// purely-static asset. The output is a valid PDF 1.4 file that PDF.js
// renders correctly (verified against pdfjs-dist@5.x).

import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const OUTPUT = path.resolve(__dirname, "..", "sample.pdf");

const PAGES = [
  {
    title: "FORGE Demo Document",
    body: [
      "Welcome to the FORGE document viewer.",
      "",
      "This sample PDF ships with FORGE so the viewer can render real",
      "content out of the box. Replace it with your own engineering",
      "drawings, P&IDs, control narratives, or SOPs by clicking",
      '"Attach PDF" in the toolbar above.',
      "",
      "Use the page navigation (prev / next or page strip) to move",
      "between pages. The annotation tools support highlights, shapes,",
      "redactions, and form fields.",
    ],
  },
  {
    title: "Page 2: Annotations",
    body: [
      "Switch to the Annotate mode in the toolbar to:",
      "",
      "  - Highlight passages",
      "  - Underline or strike text",
      "  - Add ink markup",
      "  - Drop sticky-note pin comments",
      "",
      "All annotations are scoped to the current revision and survive",
      "navigation. The annotation overlay is non-interactive in View",
      "mode so PDF text selection still works through it.",
    ],
  },
  {
    title: "Page 3: Document Control",
    body: [
      "FORGE tracks every revision, every transmittal, every approval",
      "in the audit ledger. Use the right pane to:",
      "",
      "  - View revision timeline",
      "  - Edit document metadata",
      "  - Draft transmittals",
      "  - Request approvals",
      "  - See cross-links to assets, projects, and incidents",
      "",
      "Replace this demo PDF with your own and FORGE handles the rest.",
    ],
  },
];

// --- PDF construction ---

// Each object's serialized form. We build them, compute their byte
// offsets in the final stream, then emit the xref table.
const objects = [];

// 1: Catalog
objects.push("<</Type /Catalog /Pages 2 0 R>>");

// 2: Pages (Kids will be back-filled once we know per-page object IDs)
const PAGE_FONT_OBJ = 3;
// Page objects start at object 4. Each page = page-object + content-stream.
const pageObjIds = PAGES.map((_, i) => 4 + i * 2);
objects.push(`<</Type /Pages /Kids [${pageObjIds.map(id => `${id} 0 R`).join(" ")}] /Count ${PAGES.length}>>`);

// 3: Font (shared across pages)
objects.push("<</Type /Font /Subtype /Type1 /BaseFont /Helvetica>>");

// Pages: alternate page-object + content-stream
for (const page of PAGES) {
  const lines = [];
  // Title
  lines.push("BT");
  lines.push("/F1 22 Tf");
  lines.push("72 720 Td");
  lines.push(`(${escapeText(page.title)}) Tj`);
  lines.push("ET");
  // Body
  let y = 680;
  for (const line of page.body) {
    if (line.trim()) {
      lines.push("BT");
      lines.push("/F1 11 Tf");
      lines.push(`72 ${y} Td`);
      lines.push(`(${escapeText(line)}) Tj`);
      lines.push("ET");
    }
    y -= 18;
  }
  const content = lines.join("\n");
  const contentObjId = pageObjIds[PAGES.indexOf(page)] + 1;
  // Page object
  objects.push(
    `<</Type /Page /Parent 2 0 R ` +
    `/MediaBox [0 0 612 792] ` +
    `/Resources <</Font <</F1 ${PAGE_FONT_OBJ} 0 R>>>> ` +
    `/Contents ${contentObjId} 0 R>>`
  );
  // Content stream
  objects.push(`<</Length ${Buffer.byteLength(content, "latin1")}>>\nstream\n${content}\nendstream`);
}

// Serialize the file body
let body = "%PDF-1.4\n%âãÏÓ\n";
const offsets = [];
for (let i = 0; i < objects.length; i++) {
  offsets.push(Buffer.byteLength(body, "latin1"));
  body += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
}

// xref table
const xrefStart = Buffer.byteLength(body, "latin1");
let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
for (const off of offsets) {
  xref += `${String(off).padStart(10, "0")} 00000 n \n`;
}

// Trailer
const trailer = `trailer\n<</Size ${objects.length + 1} /Root 1 0 R>>\nstartxref\n${xrefStart}\n%%EOF\n`;

const pdf = body + xref + trailer;
fs.writeFileSync(OUTPUT, pdf, "latin1");
console.log(`Wrote ${OUTPUT} (${Buffer.byteLength(pdf, "latin1")} bytes, ${PAGES.length} pages)`);

// PDF text-string escape: parens and backslash need backslash escaping;
// non-ASCII passed through as latin1 (Helvetica's StandardEncoding).
function escapeText(s) {
  return String(s).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}
