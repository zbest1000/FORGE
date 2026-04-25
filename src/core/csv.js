// CSV parser — primary path uses PapaParse (the de-facto standard for
// browser CSV). Falls back to a small hand-rolled parser if Papa fails to
// load (offline). Same return shape: { headers, rows }.

import { vendor } from "./vendor.js";

let _papa = null;
async function ensure() {
  if (_papa) return _papa;
  try { _papa = await vendor.papaparse(); return _papa; }
  catch { return null; }
}

export async function parseCSV(text) {
  const Papa = await ensure();
  if (Papa && Papa.parse) {
    const out = Papa.parse(String(text || ""), {
      header: false,
      skipEmptyLines: "greedy",
      dynamicTyping: false,
    });
    const data = out.data || [];
    const headers = data[0] || [];
    return { headers, rows: data.slice(1), errors: out.errors || [] };
  }
  // Fallback: minimal parser (handles quoted fields, escaped quotes).
  const out = [];
  let row = [], field = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else { inQ = false; }
      } else field += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === ",") { row.push(field); field = ""; }
      else if (c === "\n") { row.push(field); out.push(row); row = []; field = ""; }
      else if (c === "\r") {/* ignore */}
      else field += c;
    }
  }
  if (field || row.length) { row.push(field); out.push(row); }
  const data = out.filter(r => r.length && (r.length > 1 || r[0] !== ""));
  return { headers: data[0] || [], rows: data.slice(1), errors: [] };
}
