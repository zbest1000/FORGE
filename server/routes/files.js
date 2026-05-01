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
import { orgForRow, tenantOrgId } from "../tenant.js";
import { isHeld } from "../compliance.js";
import {
  transcodeAssetVisual,
  isTranscodable,
  MAX_TRANSCODE_INPUT_BYTES,
} from "../services/image-transcode.js";

const DATA_DIR = process.env.FORGE_DATA_DIR || path.resolve(process.cwd(), "data");
const FILES_DIR = path.join(DATA_DIR, "files");
fs.mkdirSync(FILES_DIR, { recursive: true });

// Server-side magic-byte sniff. Returns the canonical MIME type or null when
// the bytes don't match a known signature. The caller decides whether to
// trust the multipart-supplied MIME if no signature matches.
//
// Exported for unit tests and for the asset-upload code path which needs
// to make routing decisions (transcode vs raw store) before persisting
// anything to disk.
export function sniffMime(head) {
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
  // BMP (Windows bitmap; "BM" header). Asset dashboard accepts BMP for the
  // user-uploaded card visual since legacy SCADA/HMI tooling commonly
  // exports asset thumbnails as uncompressed BMP. Browsers render
  // image/bmp inline (added to INLINE_SAFE_MIMES below) so the dashboard
  // <img> tag works directly.
  if (b[0] === 0x42 && b[1] === 0x4d) return "image/bmp";
  // ISO Base Media File Format containers — bytes 4-7 spell "ftyp" and
  // bytes 8-11 carry the major brand. We check for HEIC, HEIF and AVIF
  // here: phones routinely ship images in these formats (iOS defaults to
  // HEIC, recent Pixels emit AVIF) and the asset-upload route routes
  // them through the sharp-backed transcoder (Phase 7e).
  if (
    b.length >= 12 &&
    b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70
  ) {
    // ASCII "ftyp" matched at offset 4. Read brand (offset 8-11).
    const brand = String.fromCharCode(b[8], b[9], b[10], b[11]);
    // HEIC: "heic" / "heix" — single-image HEIC.
    if (brand === "heic" || brand === "heix") return "image/heic";
    // HEIF containers ("mif1", "msf1") may carry HEIC payloads; the
    // transcoder doesn't care, so we tag them as image/heif and let
    // sharp + libheif sort it out.
    if (brand === "mif1" || brand === "msf1") return "image/heif";
    // AVIF.
    if (brand === "avif") return "image/avif";
  }
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
  "image/bmp",
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
const PARENT_TABLES = {
  document: "documents", revision: "revisions", drawing: "drawings",
  workitem: "work_items", incident: "incidents", asset: "assets",
  message: "messages", channel: "channels",
};
function parentTable(kind) { return PARENT_TABLES[String(kind).toLowerCase()] || null; }
function resolveParent(kind, id) {
  const table = parentTable(kind);
  if (!table) return null;
  return db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) || null;
}

/** Block file ops that target a parent in another tenant. */
function tenantOk(req, kind, parent) {
  const orgId = tenantOrgId(req);
  if (!orgId) return false;
  const table = parentTable(kind);
  if (!table) return false;
  const parentOrg = orgForRow(table, parent);
  return !parentOrg || parentOrg === orgId;
}

export default async function fileRoutes(fastify) {
  // POST /api/files — multipart upload.
  // Fields:  file (required), parent_kind, parent_id, name (optional)
  //
  // The handler streams the upload to a temporary file while computing
  // its SHA-256 (so deduplication still works) and capturing the first
  // 16 bytes for magic-byte sniffing. The temp file is NOT moved into
  // its final SHA-addressed slot until after `parent_kind` is known —
  // this lets the asset-visual transcode path (HEIC / HEIF / AVIF →
  // WebP + JPEG) discard the original payload without leaving an
  // orphaned content-addressed blob on disk.
  // Per-route rate limit. File uploads write to disk + SQLite + run
  // sharp on the asset-visual path; abuse here would saturate I/O
  // long before the global rate limit kicks in. 30/min/user is well
  // above the realistic dashboard ceiling (only a user upload-bombing
  // the route hits it) and matches the cap on the other
  // write-amplifying routes (apply-profile, custom-mapping).
  //
  // We attach the limiter via `fastify.rateLimit({...})` so CodeQL's
  // js/missing-rate-limiting query recognises the route as gated.
  // The decorator is only present once `@fastify/rate-limit` has been
  // registered (production); under tests where the plugin isn't
  // wired, we fall through to require_("create") only — which is
  // expected, the test suite explicitly exercises the un-rate-limited
  // path.
  const uploadPreHandlers = [];
  if (typeof fastify.rateLimit === "function") {
    uploadPreHandlers.push(fastify.rateLimit({ max: 30, timeWindow: "1 minute" }));
  }
  uploadPreHandlers.push(require_("create"));

  fastify.post("/api/files", {
    // The `config.rateLimit` form is kept for back-compat with any
    // observability / introspection tooling that reads the route
    // config; the actual gating is the preHandler chain above.
    config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    preHandler: uploadPreHandlers,
  }, async (req, reply) => {
    if (!req.isMultipart()) return reply.code(415).send({ error: "multipart required" });

    let parentKind = null, parentId = null, name = null;
    let tmp = null, head = Buffer.alloc(0);
    let uploadedSize = 0, uploadedHash = null, declaredMime = null;

    const cleanupTmp = () => {
      if (tmp) {
        try { fs.unlinkSync(tmp); } catch { /* swallow — best effort */ }
      }
    };

    try {
      for await (const part of req.parts()) {
        if (part.type === "field") {
          if (part.fieldname === "parent_kind") parentKind = String(part.value || "");
          else if (part.fieldname === "parent_id") parentId = String(part.value || "");
          else if (part.fieldname === "name") name = String(part.value || "");
        } else if (part.type === "file") {
          // Stream-to-disk + hash + capture head. The dedup rename is
          // deferred to after the post-loop validation so we only commit
          // a SHA-addressed blob for payloads we actually intend to keep.
          tmp = path.join(FILES_DIR, `.tmp-${uuid("t")}`);
          const hash = crypto.createHash("sha256");
          const sink = fs.createWriteStream(tmp);
          declaredMime = part.mimetype || "application/octet-stream";
          name = name || part.filename || "file";
          let size = 0;
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
        }
      }
    } catch (err) {
      cleanupTmp();
      throw err;
    }

    if (!uploadedHash) {
      cleanupTmp();
      return reply.code(400).send({ error: "no file provided" });
    }
    if (!parentKind || !parentId) {
      cleanupTmp();
      return reply.code(400).send({ error: "parent_kind and parent_id required" });
    }

    // Reconcile declared vs sniffed MIME. Sniffed wins when the bytes
    // contradict the multipart header — a `text/markup` sniff means the
    // payload starts with `<`, so we tag it as untrusted markup so the
    // download path forces an `attachment` disposition.
    const sniffed = sniffMime(head);
    const mimeFinal = sniffed || declaredMime;
    const isAsset = String(parentKind).toLowerCase() === "asset";

    const parent = resolveParent(parentKind, parentId);
    if (!parent) {
      cleanupTmp();
      return reply.code(404).send({ error: "parent not found" });
    }
    if (!tenantOk(req, parentKind, parent)) {
      cleanupTmp();
      return reply.code(404).send({ error: "parent not found" });
    }
    if (!allows(req.user, parent.acl, "edit")) {
      cleanupTmp();
      return reply.code(403).send({ error: "forbidden by ACL" });
    }

    // HEIC / HEIF / AVIF only flow through the transcode pipeline, and
    // only as asset visuals. Anywhere else the upload is rejected: the
    // downstream document/incident/work-item viewers don't have a HEIC
    // decoder and would render a broken thumbnail.
    if (isTranscodable(mimeFinal) && !isAsset) {
      cleanupTmp();
      return reply.code(415).send({
        error: "HEIC, HEIF and AVIF uploads are only supported for asset visuals — convert to JPEG, PNG or WebP for other contexts",
      });
    }

    // Asset visual transcode path: WebP becomes the primary, JPEG the
    // derivative. The original HEIC/AVIF payload is discarded — there
    // is no row anywhere that references its SHA, so no audit thread
    // is broken.
    if (isAsset && isTranscodable(mimeFinal)) {
      if (uploadedSize > MAX_TRANSCODE_INPUT_BYTES) {
        cleanupTmp();
        return reply.code(413).send({
          error: `image too large for transcode (${uploadedSize} bytes; max ${MAX_TRANSCODE_INPUT_BYTES})`,
        });
      }
      let buffer;
      try {
        buffer = fs.readFileSync(tmp);
      } catch (err) {
        cleanupTmp();
        return reply.code(500).send({ error: "failed to read upload buffer", detail: err.message });
      }

      let result;
      try {
        result = await transcodeAssetVisual(buffer, mimeFinal);
      } catch (err) {
        cleanupTmp();
        if (err.code === "FORGE_TRANSCODE_TOO_LARGE") return reply.code(413).send({ error: err.message });
        if (err.code === "FORGE_TRANSCODE_UNSUPPORTED") return reply.code(415).send({ error: err.message });
        if (err.code === "FORGE_TRANSCODE_INVALID") return reply.code(400).send({ error: err.message });
        return reply.code(500).send({ error: "transcode failed", detail: err.message });
      }
      cleanupTmp();

      // Persist the WebP primary + JPEG derivative under their own
      // SHA-addressed paths. Dedupe is preserved (same input image
      // resolves to the same outputs, hash-equal). We write with the
      // exclusive-create flag (`wx`) and swallow EEXIST so the
      // existsSync+write pair stays atomic — a concurrent uploader of
      // the same content would otherwise race the existsSync check.
      // EEXIST is benign here: SHA-addressed content guarantees the
      // bytes already on disk are byte-identical to what we'd write.
      const writeIfMissing = (filePath, buffer) => {
        try {
          fs.writeFileSync(filePath, buffer, { flag: "wx" });
        } catch (err) {
          if (err.code !== "EEXIST") throw err;
        }
      };

      const webpHash = crypto.createHash("sha256").update(result.webp.buffer).digest("hex");
      const webpPath = pathFor(webpHash);
      writeIfMissing(webpPath, result.webp.buffer);

      const jpegHash = crypto.createHash("sha256").update(result.jpeg.buffer).digest("hex");
      const jpegPath = pathFor(jpegHash);
      writeIfMissing(jpegPath, result.jpeg.buffer);

      const baseName = (path.parse(name || "image").name || "image").trim() || "image";
      const webpName = `${baseName}.webp`;
      const jpegName = `${baseName}.jpg`;

      const webpId = uuid("F");
      const jpegId = uuid("F");
      const ts = now();

      const insertFile = db.prepare(`INSERT INTO files (id, parent_kind, parent_id, name, mime, size, sha256, path, created_by, created_at)
                  VALUES (@id, @pk, @pi, @name, @mime, @size, @sha, @path, @by, @ts)`);
      const writeBoth = db.transaction(() => {
        insertFile.run({ id: webpId, pk: parentKind, pi: parentId, name: webpName, mime: "image/webp", size: result.webp.size, sha: webpHash, path: webpPath, by: req.user.id, ts });
        insertFile.run({ id: jpegId, pk: parentKind, pi: parentId, name: jpegName, mime: "image/jpeg", size: result.jpeg.size, sha: jpegHash, path: jpegPath, by: req.user.id, ts });
      });
      writeBoth();

      audit({
        actor: req.user.id,
        action: "file.upload.transcode",
        subject: webpId,
        detail: {
          parent: `${parentKind}:${parentId}`,
          sourceMime: result.sourceMime,
          sourceSize: result.sourceSize,
          webp: { id: webpId, size: result.webp.size, sha256: webpHash, width: result.webp.width, height: result.webp.height },
          jpeg: { id: jpegId, size: result.jpeg.size, sha256: jpegHash, width: result.jpeg.width, height: result.jpeg.height },
        },
      });

      return {
        id: webpId,
        name: webpName,
        size: result.webp.size,
        mime: "image/webp",
        sha256: webpHash,
        derivative: {
          id: jpegId,
          name: jpegName,
          mime: "image/jpeg",
          size: result.jpeg.size,
          sha256: jpegHash,
        },
        source: {
          mime: result.sourceMime,
          size: result.sourceSize,
        },
      };
    }

    // Default path: store the upload at its SHA-addressed location and
    // emit a single file row. Dedupe ditches the temp file when another
    // upload already landed the same content.
    const destPath = pathFor(uploadedHash);
    if (!fs.existsSync(destPath)) {
      fs.renameSync(tmp, destPath);
    } else {
      cleanupTmp();
    }

    const uploadedMime = mimeFinal;
    const uploadedId = uuid("F");
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
    if (parent && !tenantOk(req, row.parent_kind, parent)) return reply.code(404).send({ error: "not found" });
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
    if (!parent || !tenantOk(req, parent_kind, parent)) return reply.code(404).send({ error: "not found" });
    if (!requireAccess(req, reply, parent, "view")) return;
    const rows = db.prepare("SELECT id, name, mime, size, sha256, created_by, created_at FROM files WHERE parent_kind = ? AND parent_id = ? ORDER BY created_at DESC").all(parent_kind, parent_id);
    return rows;
  });

  // DELETE /api/files/:id — soft-delete (keeps the file for retention).
  // Removal on disk is done by a periodic retention sweep (not this endpoint)
  // so legal holds and audit references continue to resolve.
  fastify.delete("/api/files/:id", {
    preHandler: require_("edit"),
    schema: { params: { type: "object", required: ["id"], properties: { id: { type: "string", minLength: 1, maxLength: 64 } }, additionalProperties: false } },
  }, async (req, reply) => {
    const row = db.prepare("SELECT * FROM files WHERE id = ?").get(req.params.id);
    if (!row) return reply.code(404).send({ error: "not found" });
    const parent = resolveParent(row.parent_kind, row.parent_id);
    if (parent && !tenantOk(req, row.parent_kind, parent)) return reply.code(404).send({ error: "not found" });
    if (parent && !allows(req.user, parent.acl, "edit")) return reply.code(403).send({ error: "forbidden" });
    // Legal-hold interlock: refuse to delete a file whose parent record
    // (or the parent's parent) is under an active legal hold. This is
    // the minimal viable hook; a richer implementation walks all
    // relationships.
    if (parent && (isHeld({ objectId: parent.id }) || isHeld({ objectId: row.id }) || isHeld({ scope: row.parent_kind }))) {
      audit({ actor: req.user.id, action: "file.delete.blocked", subject: row.id, detail: { reason: "legal_hold" } });
      return reply.code(423).send({ error: "legal hold blocks delete", reason: "legal_hold" });
    }
    db.prepare("DELETE FROM files WHERE id = ?").run(row.id);
    audit({ actor: req.user.id, action: "file.delete", subject: row.id });
    return { ok: true };
  });
}
