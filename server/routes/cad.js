// /api/cad/* — CAD format detection + DWG conversion + serving converted
// outputs. Reads files from the existing `files` table; conversion
// outputs are cached by SHA-256 in `<DATA_DIR>/converted/<sha>.dxf`.

import fs from "node:fs";
import path from "node:path";
import { db } from "../db.js";
import { audit } from "../audit.js";
import { require_ } from "../auth.js";
import { allows } from "../acl.js";
import { convertDwgToDxf, pathFromFileRow, hasConverter, CONVERTED_DIR_PATH } from "../converters/dwg.js";

function detectKindFromName(name) {
  const m = String(name || "").toLowerCase().match(/\.([a-z0-9]+)(?:\?|$)/);
  return m ? m[1] : "";
}

export default async function cadRoutes(fastify) {
  fastify.get("/api/cad/info", { preHandler: require_("view") }, async () => ({
    converters: { dwg2dxf: await hasConverter() },
  }));

  fastify.get("/api/cad/info/:fileId", { preHandler: require_("view") }, async (req, reply) => {
    const row = db.prepare("SELECT * FROM files WHERE id = ?").get(req.params.fileId);
    if (!row) return reply.code(404).send({ error: "file not found" });
    return { id: row.id, name: row.name, mime: row.mime, sha256: row.sha256, kind: detectKindFromName(row.name) };
  });

  // Convert by FORGE file id.
  fastify.post("/api/cad/convert/:fileId", { preHandler: require_("edit") }, async (req, reply) => {
    const row = db.prepare("SELECT * FROM files WHERE id = ?").get(req.params.fileId);
    if (!row) return reply.code(404).send({ error: "file not found" });
    // ACL: same model as file download — verify against the parent record.
    const parent = resolveParent(row.parent_kind, row.parent_id);
    if (parent && !allows(req.user, parent.acl, "edit")) {
      return reply.code(403).send({ error: "forbidden by ACL" });
    }
    const to = req.query?.to || "dxf";
    if (to !== "dxf") return reply.code(400).send({ error: "unsupported target", to });
    if (!/\.dwg$/i.test(row.name) && row.mime !== "application/acad" && row.mime !== "image/vnd.dwg") {
      return reply.code(400).send({ error: "source is not DWG", name: row.name, mime: row.mime });
    }
    const local = pathFromFileRow(row);
    if (!local) return reply.code(410).send({ error: "content missing" });
    try {
      const out = await convertDwgToDxf({ filePath: local });
      audit({ actor: req.user.id, action: "cad.convert", subject: row.id, detail: { to, sha256: out.sha256, cached: out.cached } });
      return { ok: true, sha256: out.sha256, cached: out.cached, url: `/api/cad/converted/${out.sha256}.dxf` };
    } catch (err) {
      const code = err?.code === "ERR_DWG_CONVERTER_MISSING" ? 503 : 500;
      audit({ actor: req.user.id, action: "cad.convert.error", subject: row.id, detail: { to, error: String(err?.message || err) } });
      return reply.code(code).send({ error: String(err?.message || err) });
    }
  });

  // Convert by external URL (e.g. revision.assetUrl).
  fastify.post("/api/cad/convert", { preHandler: require_("edit") }, async (req, reply) => {
    const { url, to = "dxf" } = req.body || {};
    if (!url) return reply.code(400).send({ error: "url required" });
    if (to !== "dxf") return reply.code(400).send({ error: "unsupported target" });
    if (!/^https?:\/\//.test(url)) return reply.code(400).send({ error: "url must be http(s)" });
    try {
      const out = await convertDwgToDxf({ url });
      audit({ actor: req.user.id, action: "cad.convert.url", subject: url, detail: { sha256: out.sha256, cached: out.cached } });
      return { ok: true, sha256: out.sha256, cached: out.cached, url: `/api/cad/converted/${out.sha256}.dxf` };
    } catch (err) {
      const code = err?.code === "ERR_DWG_CONVERTER_MISSING" ? 503 : 500;
      return reply.code(code).send({ error: String(err?.message || err) });
    }
  });

  // Serve a converted DXF by its content hash.
  fastify.get("/api/cad/converted/:name", async (req, reply) => {
    const safe = String(req.params.name).replace(/[^a-f0-9.-]/gi, "");
    if (!/^[a-f0-9]{64}\.dxf$/i.test(safe)) return reply.code(400).send({ error: "bad name" });
    const p = path.join(CONVERTED_DIR_PATH, safe);
    if (!fs.existsSync(p)) return reply.code(404).send({ error: "not found" });
    reply.header("Content-Type", "application/dxf");
    reply.header("Cache-Control", "public, max-age=31536000, immutable");
    return reply.send(fs.createReadStream(p));
  });
}

function resolveParent(kind, id) {
  const table = ({
    document: "documents", revision: "revisions", drawing: "drawings",
    workitem: "work_items", incident: "incidents", asset: "assets",
    message: "messages", channel: "channels",
  })[String(kind).toLowerCase()];
  if (!table) return null;
  return db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) || null;
}
