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
import { allows } from "../acl.js";
import { require_ } from "../auth.js";

const DATA_DIR = process.env.FORGE_DATA_DIR || path.resolve(process.cwd(), "data");
const FILES_DIR = path.join(DATA_DIR, "files");
fs.mkdirSync(FILES_DIR, { recursive: true });

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
        uploadedMime = part.mimetype || "application/octet-stream";
        name = name || part.filename || "file";
        let size = 0;
        await pipeline(async function* () {
          for await (const chunk of part.file) { size += chunk.length; hash.update(chunk); yield chunk; }
        }(), sink);
        uploadedSize = size;
        uploadedHash = hash.digest("hex");
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
    reply.header("Content-Type", row.mime || "application/octet-stream");
    reply.header("Content-Length", String(row.size));
    reply.header("Content-Disposition", `inline; filename="${(row.name || "file").replace(/[^\w.\-]/g, "_")}"`);
    reply.header("X-Content-SHA256", row.sha256);
    return reply.send(fs.createReadStream(row.path));
  });

  // GET /api/files?parent_kind=&parent_id= — listing.
  fastify.get("/api/files", async (req, reply) => {
    const { parent_kind, parent_id } = req.query || {};
    if (!parent_kind || !parent_id) return reply.code(400).send({ error: "parent_kind and parent_id required" });
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
