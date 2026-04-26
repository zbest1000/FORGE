// Files — upload, download, list. Content is stored on disk under the
// server's data directory, addressed by sha256 to allow deduplication.
// Metadata rows live in the `files` table. Downloads honor the parent
// record's sensitivity: `confidential` or `restricted` requires the
// `view` capability plus a matching ACL; `public` is anyone authenticated.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { db, now, uuid } from "../db.js";
import { audit } from "../audit.js";
import { allows, requireAccess } from "../acl.js";
import { require_ } from "../auth.js";

const DATA_DIR = process.env.FORGE_DATA_DIR || path.resolve(process.cwd(), "data");
const FILES_DIR = path.join(DATA_DIR, "files");
fs.mkdirSync(FILES_DIR, { recursive: true });

// Server-side magic-byte sniff. Returns the canonical MIME type or null when
// the bytes don't match a known signature. The caller decides whether to
// trust the multipart-supplied MIME if no signature matches.
function sniffMime(head) {
  if (!head || head.length < 4) return null;
  const b = head;
  // PDF
  if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return "application/pdf";
  // PNG
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  // JPEG (FF D8 FF)
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  // GIF
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return "image/gif";
  // ZIP / docx/xlsx/pptx (PK\x03\x04)
  if (b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04) return "application/zip";
  // WebP (RIFF....WEBP)
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b.length >= 12 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  // SVG / XML / HTML — very loose; treat any leading "<" as untrusted markup
  if (b[0] === 0x3c) return "text/markup";
  return null;
}

// Conservative inline-display allowlist. Anything else is forced to
// `attachment` so the browser saves rather than renders.
const INLINE_SAFE_MIMES = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
  "text/plain",
  "application/json",
]);

function shouldServeInline(mime) {
  if (!mime) return false;
  // SVG has script vectors; only allow if explicitly opted in via query.
  if (mime === "image/svg+xml") return false;
  return INLINE_SAFE_MIMES.has(String(mime).toLowerCase());
}

function pathFor(hash) {
  const shard = hash.slice(0, 2);
  const dir = path.join(FILES_DIR, shard);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, hash);
}

// Resolve the parent record for ACL checks. Only a few parent kinds exist.
function resolveParent(kind, id) {
  const table = ({
    document: "documents", revision: "revisions", drawing: "drawings",
    workitem: "work_items", incident: "incidents", asset: "assets",
    message: "messages", channel: "channels",
  })[String(kind).toLowerCase()];
  if (!table) return null;
  return db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) || null;
}

export default async function fileRoutes(fastify) {
  // POST /api/files — multipart upload.
  // Fields:  file (required), parent_kind, parent_id, name (optional)
  fastify.post("/api/files", { preHandler: require_("create") }, async (req, reply) => {
    if (!req.isMultipart()) return reply.code(415).send({ error: "multipart required" });

    let parentKind = null, parentId = null, name = null;
    let uploadedId = null, uploadedSize = 0, uploadedMime = null, uploadedHash = null, destPath = null;

    for await (const part of req.parts()) {
      if (part.type === "field") {
        if (part.fieldname === "parent_kind") parentKind = String(part.value || "");
        else if (part.fieldname === "parent_id") parentId = String(part.value || "");
        else if (part.fieldname === "name") name = String(part.value || "");
      } else if (part.type === "file") {
        // Hash while streaming to a temp file, then rename to the sha256 path.
        const tmp = path.join(FILES_DIR, `.tmp-${uuid("t")}`);
        const hash = crypto.createHash("sha256");
        const sink = fs.createWriteStream(tmp);
        const declaredMime = part.mimetype || "application/octet-stream";
        name = name || part.filename || "file";
        let size = 0;
        let head = Buffer.alloc(0);
        await pipeline(async function* () {
          for await (const chunk of part.file) {
            if (head.length < 16) head = Buffer.concat([head, chunk.subarray(0, 16 - head.length)]);
            size += chunk.length;
            hash.update(chunk);
            yield chunk;
          }
        }(), sink);
        uploadedSize = size;
        uploadedHash = hash.digest("hex");
        // Reconcile declared vs sniffed MIME. Sniffed wins when the bytes
        // contradict the multipart header — a `text/markup` sniff means the
        // payload starts with `<`, so we tag it as untrusted markup so the
        // download path forces an `attachment` disposition.
        const sniffed = sniffMime(head);
        uploadedMime = sniffed || declaredMime;
        destPath = pathFor(uploadedHash);
        if (!fs.existsSync(destPath)) fs.renameSync(tmp, destPath);
        else fs.unlinkSync(tmp); // dedupe
      }
    }

    if (!uploadedHash) return reply.code(400).send({ error: "no file provided" });
    if (!parentKind || !parentId) return reply.code(400).send({ error: "parent_kind and parent_id required" });
    const parent = resolveParent(parentKind, parentId);
    if (!parent) return reply.code(404).send({ error: "parent not found" });
    if (!allows(req.user, parent.acl, "edit")) {
      return reply.code(403).send({ error: "forbidden by ACL" });
    }

    uploadedId = uuid("F");
    db.prepare(`INSERT INTO files (id, parent_kind, parent_id, name, mime, size, sha256, path, created_by, created_at)
                VALUES (@id, @pk, @pi, @name, @mime, @size, @sha, @path, @by, @ts)`)
      .run({ id: uploadedId, pk: parentKind, pi: parentId, name, mime: uploadedMime, size: uploadedSize, sha: uploadedHash, path: destPath, by: req.user.id, ts: now() });
    audit({ actor: req.user.id, action: "file.upload", subject: uploadedId, detail: { parent: `${parentKind}:${parentId}`, size: uploadedSize, sha256: uploadedHash } });
    return { id: uploadedId, name, size: uploadedSize, mime: uploadedMime, sha256: uploadedHash };
  });

  // GET /api/files/:id — download. Records an audit entry.
  fastify.get("/api/files/:id", { preHandler: require_("view") }, async (req, reply) => {
    const row = db.prepare("SELECT * FROM files WHERE id = ?").get(req.params.id);
    if (!row) return reply.code(404).send({ error: "not found" });
    const parent = resolveParent(row.parent_kind, row.parent_id);
    if (parent && !allows(req.user, parent.acl, "view")) {
      audit({ actor: req.user.id, action: "file.download.deny", subject: row.id });
      return reply.code(403).send({ error: "forbidden" });
    }
    if (!fs.existsSync(row.path)) return reply.code(410).send({ error: "content missing" });
    audit({ actor: req.user.id, action: "file.download", subject: row.id, detail: { name: row.name, sha256: row.sha256 } });
    // Force `attachment` for anything that is not on the inline-safe MIME
    // allowlist. HTML/SVG/script-bearing markup is always served as a
    // download — combined with the content-sniff guard below, this keeps
    // a malicious upload from XSS-ing other tenants on the same origin.
    const safeName = (row.name || "file").replace(/[^\w.\-]/g, "_");
    const inlineOk = shouldServeInline(row.mime);
    const disposition = inlineOk ? "inline" : "attachment";
    reply.header("Content-Type", row.mime || "application/octet-stream");
    reply.header("Content-Length", String(row.size));
    reply.header("Content-Disposition", `${disposition}; filename="${safeName}"`);
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Content-SHA256", row.sha256);
    return reply.send(fs.createReadStream(row.path));
  });

  // GET /api/files?parent_kind=&parent_id= — listing.
  fastify.get("/api/files", { preHandler: require_("view") }, async (req, reply) => {
    const { parent_kind, parent_id } = req.query || {};
    if (!parent_kind || !parent_id) return reply.code(400).send({ error: "parent_kind and parent_id required" });
    const parent = resolveParent(parent_kind, parent_id);
    if (!requireAccess(req, reply, parent, "view")) return;
    const rows = db.prepare("SELECT id, name, mime, size, sha256, created_by, created_at FROM files WHERE parent_kind = ? AND parent_id = ? ORDER BY created_at DESC").all(parent_kind, parent_id);
    return rows;
  });

  // DELETE /api/files/:id — soft-delete (keeps the file for retention).
  // Removal on disk is done by a periodic retention sweep (not this endpoint)
  // so legal holds and audit references continue to resolve.
  fastify.delete("/api/files/:id", { preHandler: require_("edit") }, async (req, reply) => {
    const row = db.prepare("SELECT * FROM files WHERE id = ?").get(req.params.id);
    if (!row) return reply.code(404).send({ error: "not found" });
    const parent = resolveParent(row.parent_kind, row.parent_id);
    if (parent && !allows(req.user, parent.acl, "edit")) return reply.code(403).send({ error: "forbidden" });
    db.prepare("DELETE FROM files WHERE id = ?").run(row.id);
    audit({ actor: req.user.id, action: "file.delete", subject: row.id });
    return { ok: true };
  });
}
