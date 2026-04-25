// DWG → DXF converter using LibreDWG's `dwg2dxf` CLI (GPL-3.0).
//
// LibreDWG runs as a subprocess so its GPL copyleft only applies to its
// own binary, not to FORGE's code (the same "deployed service" exception
// we use for n8n's SUL container and Mosquitto). The converter caches
// outputs by SHA-256 in `<DATA_DIR>/converted/<sha>.dxf`, so repeat
// requests are O(1).
//
// If `dwg2dxf` is not on PATH the converter logs a notice and returns a
// `not-installed` error; the client falls back to a download link.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";

const DATA_DIR = process.env.FORGE_DATA_DIR || path.resolve(process.cwd(), "data");
const FILES_DIR = path.join(DATA_DIR, "files");
const CONVERTED_DIR = path.join(DATA_DIR, "converted");
fs.mkdirSync(CONVERTED_DIR, { recursive: true });

// Path to the converter binary. Default `dwg2dxf` (LibreDWG) but
// operators can override (e.g. `oda-file-converter`, ODA File Converter,
// when an enterprise license is held).
const DWG2DXF = process.env.FORGE_DWG2DXF || "dwg2dxf";

let _hasConverterPromise = null;
export function hasConverter() {
  if (_hasConverterPromise) return _hasConverterPromise;
  _hasConverterPromise = new Promise((resolve) => {
    const p = spawn(DWG2DXF, ["--version"], { stdio: "ignore" });
    p.on("error", () => resolve(false));
    p.on("exit", (code) => resolve(code === 0));
  });
  return _hasConverterPromise;
}

async function sha256OfFile(filePath) {
  const h = crypto.createHash("sha256");
  await pipeline(fs.createReadStream(filePath), async function* (src) {
    for await (const chunk of src) { h.update(chunk); yield chunk; }
  });
  return h.digest("hex");
}

async function downloadToTmp(url) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 60_000);
  try {
    const res = await fetch(url, { signal: ac.signal });
    if (!res.ok) throw new Error(`fetch ${url} → HTTP ${res.status}`);
    const tmp = path.join(CONVERTED_DIR, `.dl-${crypto.randomBytes(8).toString("hex")}`);
    const ws = fs.createWriteStream(tmp);
    await pipeline(res.body, ws);
    return tmp;
  } finally { clearTimeout(t); }
}

/**
 * Convert a DWG (referenced by an existing FORGE file id, or a URL) to
 * DXF. Returns `{ path, sha256, cached, contentType }` for the cached
 * output. Throws on converter errors.
 */
export async function convertDwgToDxf({ filePath, url } = {}) {
  if (!filePath && url) filePath = await downloadToTmp(url);
  if (!filePath) throw new Error("convertDwgToDxf: filePath or url required");

  const sha = await sha256OfFile(filePath);
  const out = path.join(CONVERTED_DIR, `${sha}.dxf`);
  if (fs.existsSync(out)) {
    return { path: out, sha256: sha, cached: true, contentType: "application/dxf" };
  }

  const has = await hasConverter();
  if (!has) {
    const e = new Error("LibreDWG dwg2dxf is not installed on this server. Install `libredwg-tools` or set FORGE_DWG2DXF to a compatible converter.");
    e.code = "ERR_DWG_CONVERTER_MISSING";
    throw e;
  }

  await new Promise((resolve, reject) => {
    // dwg2dxf <input> -o <output>
    const p = spawn(DWG2DXF, [filePath, "-o", out], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    p.stderr.on("data", (b) => { stderr += b.toString(); });
    p.on("error", reject);
    p.on("exit", (code) => {
      if (code === 0 && fs.existsSync(out)) return resolve();
      // Some LibreDWG builds emit the DXF next to the input regardless of -o.
      const sibling = filePath.replace(/\.dwg$/i, ".dxf");
      if (code === 0 && fs.existsSync(sibling)) {
        fs.renameSync(sibling, out);
        return resolve();
      }
      reject(new Error(`dwg2dxf exit ${code}: ${stderr.slice(0, 500)}`));
    });
  });

  return { path: out, sha256: sha, cached: false, contentType: "application/dxf" };
}

/**
 * Resolve the path of a stored FORGE file row to a local file on disk.
 * Files uploaded via `/api/files` already live on disk under
 * `data/files/<sha[:2]>/<sha>`; the row's `path` column points at it.
 */
export function pathFromFileRow(row) {
  if (!row?.path || !fs.existsSync(row.path)) return null;
  return row.path;
}

export const CONVERTED_DIR_PATH = CONVERTED_DIR;
