// Phase 7e — image transcode pipeline.
//
// This file covers two layers:
//
//   1. Pure unit tests for the magic-byte sniffer (`sniffMime`) and the
//      `transcodeAssetVisual` service. Synthetic AVIF is generated in
//      memory via sharp.create() and re-encoded; HEIC is exercised via
//      crafted ftyp headers because libvips on most build configs can
//      decode HEIC but cannot encode it (HEVC is patent-encumbered),
//      so we cannot reliably synthesise a HEIC fixture cross-platform.
//
//   2. A small end-to-end test that boots Fastify in-process, registers
//      `server/routes/files.js`, and POSTs an AVIF blob with
//      `parent_kind=asset`. It asserts the response shape (WebP primary
//      + JPEG derivative + source metadata) and round-trips both file
//      ids back through `GET /api/files/:id` to confirm the bytes are
//      decodable. A second case POSTs an AVIF with `parent_kind=document`
//      and asserts the route refuses the upload (415).

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Fresh DB per run — this guarantees the in-process Fastify app sees a
// migrated SQLite without colliding with sibling tests.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-img-transcode-"));
process.env.FORGE_DATA_DIR = tmpDir;
process.env.FORGE_TENANT_KEY = "forge-img-transcode-test";
process.env.FORGE_JWT_SECRET = "forge-img-transcode-jwt";
process.env.FORGE_RATELIMIT_MAX = "10000";
process.env.LOG_LEVEL = "warn";

// Triggers migrations and gives us a hot DB handle.
const { db } = await import("../server/db.js");
const sharp = (await import("sharp")).default;

// Module under test.
const { sniffMime } = await import("../server/routes/files.js");
const {
  transcodeAssetVisual,
  isTranscodable,
  MAX_TRANSCODE_INPUT_BYTES,
} = await import("../server/services/image-transcode.js");

// ────────────────────────────────────────────────────────────────────
// Magic-byte sniffer unit tests
// ────────────────────────────────────────────────────────────────────

// Build a 16-byte ISO Base Media File Format header with the supplied
// 4-character brand at offset 8. `size` field at offset 0-3 is fixed
// at 0x18 (24) — the exact value doesn't matter for the sniffer.
function ftypHeader(brand) {
  const buf = Buffer.alloc(16, 0);
  buf.writeUInt32BE(0x18, 0);                       // size
  buf.write("ftyp", 4, "ascii");                    // box type
  buf.write(brand, 8, "ascii");                     // major brand
  return buf;
}

test("sniffMime detects HEIC ftyp brand 'heic'", () => {
  assert.equal(sniffMime(ftypHeader("heic")), "image/heic");
});

test("sniffMime detects HEIC ftyp brand 'heix'", () => {
  assert.equal(sniffMime(ftypHeader("heix")), "image/heic");
});

test("sniffMime detects HEIF ftyp brand 'mif1'", () => {
  assert.equal(sniffMime(ftypHeader("mif1")), "image/heif");
});

test("sniffMime detects HEIF ftyp brand 'msf1'", () => {
  assert.equal(sniffMime(ftypHeader("msf1")), "image/heif");
});

test("sniffMime detects AVIF ftyp brand 'avif'", () => {
  assert.equal(sniffMime(ftypHeader("avif")), "image/avif");
});

test("sniffMime ignores unknown ftyp brands", () => {
  // The ftyp prefix is correct but the brand isn't one we recognise;
  // sniffer must NOT mis-classify as one of the transcodable formats.
  assert.equal(sniffMime(ftypHeader("isom")), null);
  assert.equal(sniffMime(ftypHeader("mp42")), null);
  assert.equal(sniffMime(ftypHeader("qt  ")), null);
});

test("sniffMime returns null when head is shorter than 12 bytes", () => {
  assert.equal(sniffMime(Buffer.alloc(0)), null);
  assert.equal(sniffMime(Buffer.from([0x00])), null);
  assert.equal(sniffMime(Buffer.alloc(11)), null);
});

test("sniffMime continues to detect existing formats after the HEIC/AVIF refactor", () => {
  // Regression guard: the new ftyp branch must not shadow PNG/JPEG/WebP/BMP/PDF.
  assert.equal(sniffMime(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), "image/png");
  assert.equal(sniffMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])), "image/jpeg");
  assert.equal(sniffMime(Buffer.from([0x42, 0x4d, 0x36, 0x84, 0x00, 0x00])), "image/bmp");
  assert.equal(sniffMime(Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d])), "application/pdf");
  // RIFF....WEBP at offset 8.
  const webp = Buffer.alloc(12);
  webp.write("RIFF", 0, "ascii");
  webp.writeUInt32LE(0, 4);
  webp.write("WEBP", 8, "ascii");
  assert.equal(sniffMime(webp), "image/webp");
});

// ────────────────────────────────────────────────────────────────────
// Transcoder unit tests
// ────────────────────────────────────────────────────────────────────

test("isTranscodable matches HEIC, HEIF and AVIF (case-insensitive)", () => {
  assert.equal(isTranscodable("image/heic"), true);
  assert.equal(isTranscodable("image/heif"), true);
  assert.equal(isTranscodable("image/avif"), true);
  assert.equal(isTranscodable("IMAGE/AVIF"), true);
  assert.equal(isTranscodable("image/jpeg"), false);
  assert.equal(isTranscodable("image/png"), false);
  assert.equal(isTranscodable("image/webp"), false);
  assert.equal(isTranscodable("image/bmp"), false);
  assert.equal(isTranscodable(null), false);
  assert.equal(isTranscodable(""), false);
  assert.equal(isTranscodable(undefined), false);
});

test("transcodeAssetVisual round-trips synthetic AVIF into WebP + JPEG", async () => {
  // sharp.create() generates a synthetic raw canvas; we then encode
  // it to AVIF in memory so the test fixture exists without checking
  // a binary into the repo. This mirrors the user's spec: "use
  // sharp.create() to generate a synthetic HEIC/AVIF in memory".
  const png = await sharp({
    create: { width: 256, height: 256, channels: 3, background: { r: 200, g: 80, b: 120 } },
  }).png().toBuffer();
  const avif = await sharp(png).avif({ quality: 70, effort: 4 }).toBuffer();

  // Sanity: the synthetic buffer really does sniff as AVIF.
  assert.equal(sniffMime(avif.subarray(0, 16)), "image/avif");

  const result = await transcodeAssetVisual(avif, "image/avif");

  // Both outputs exist and are non-empty.
  assert.ok(Buffer.isBuffer(result.webp.buffer), "webp.buffer is a Buffer");
  assert.ok(Buffer.isBuffer(result.jpeg.buffer), "jpeg.buffer is a Buffer");
  assert.ok(result.webp.size > 0, "webp.size > 0");
  assert.ok(result.jpeg.size > 0, "jpeg.size > 0");
  assert.equal(result.webp.size, result.webp.buffer.length, "webp.size matches buffer length");
  assert.equal(result.jpeg.size, result.jpeg.buffer.length, "jpeg.size matches buffer length");

  // Reported MIMEs match the encoder.
  assert.equal(result.webp.mime, "image/webp");
  assert.equal(result.jpeg.mime, "image/jpeg");

  // Source metadata is preserved verbatim (lower-cased).
  assert.equal(result.sourceMime, "image/avif");
  assert.equal(result.sourceSize, avif.length);

  // Width / height are reported and bounded by the resize cap.
  assert.ok(result.webp.width > 0 && result.webp.width <= 2048);
  assert.ok(result.webp.height > 0 && result.webp.height <= 2048);
  assert.ok(result.jpeg.width > 0 && result.jpeg.width <= 2048);
  assert.ok(result.jpeg.height > 0 && result.jpeg.height <= 2048);

  // The output buffers actually parse as their stated formats. This
  // closes the loop — without a successful re-decode, the bytes might
  // be an encoder mis-fire wearing a magic-byte costume.
  const webpMeta = await sharp(result.webp.buffer).metadata();
  assert.equal(webpMeta.format, "webp");

  const jpegMeta = await sharp(result.jpeg.buffer).metadata();
  assert.equal(jpegMeta.format, "jpeg");
});

test("transcodeAssetVisual rejects payloads larger than 25 MB", async () => {
  // Construct a buffer one byte over the cap with valid AVIF magic at
  // the front so the failure is the size-cap check and not the MIME
  // guard or the decoder.
  const oversized = Buffer.alloc(MAX_TRANSCODE_INPUT_BYTES + 1, 0);
  oversized.writeUInt32BE(0x18, 0);
  oversized.write("ftyp", 4, "ascii");
  oversized.write("avif", 8, "ascii");

  await assert.rejects(
    () => transcodeAssetVisual(oversized, "image/avif"),
    (err) => {
      assert.equal(err.code, "FORGE_TRANSCODE_TOO_LARGE");
      assert.match(err.message, /25.*MB|26214401|exceeds/i);
      return true;
    },
    "should reject with FORGE_TRANSCODE_TOO_LARGE",
  );
});

test("transcodeAssetVisual rejects unsupported MIME", async () => {
  await assert.rejects(
    () => transcodeAssetVisual(Buffer.from("hello"), "image/png"),
    (err) => err.code === "FORGE_TRANSCODE_UNSUPPORTED",
  );
  await assert.rejects(
    () => transcodeAssetVisual(Buffer.from("hello"), "image/jpeg"),
    (err) => err.code === "FORGE_TRANSCODE_UNSUPPORTED",
  );
});

test("transcodeAssetVisual rejects non-Buffer / empty input", async () => {
  await assert.rejects(
    () => transcodeAssetVisual("not-a-buffer", "image/avif"),
    (err) => err.code === "FORGE_TRANSCODE_INVALID",
  );
  await assert.rejects(
    () => transcodeAssetVisual(Buffer.alloc(0), "image/avif"),
    (err) => err.code === "FORGE_TRANSCODE_INVALID",
  );
});

test("transcodeAssetVisual surfaces a structured error when bytes are not a real image", async () => {
  // 512 bytes of zeros — definitely not a decodable image. Sharp's
  // metadata() call inside the service should raise INVALID, not
  // bubble up the raw libvips error.
  const garbage = Buffer.alloc(512, 0);
  await assert.rejects(
    () => transcodeAssetVisual(garbage, "image/avif"),
    (err) => /^FORGE_TRANSCODE_(INVALID|FAILED)$/.test(err.code || ""),
  );
});

// ────────────────────────────────────────────────────────────────────
// Upload route integration
// ────────────────────────────────────────────────────────────────────

const ts = new Date().toISOString();
db.prepare("INSERT INTO organizations (id, name, tenant_key, created_at) VALUES ('ORG-IMG','Atlas','atlas-img',?)").run(ts);
db.prepare("INSERT INTO workspaces (id, org_id, name, region, created_at) VALUES ('WS-IMG','ORG-IMG','North','us-east',?)").run(ts);
const bcrypt = (await import("bcryptjs")).default;
db.prepare("INSERT INTO users (id, org_id, email, name, role, password_hash, initials, disabled, created_at, updated_at) VALUES ('U-IMG','ORG-IMG','admin@forge.local','Admin','Organization Owner',?,'AD',0,?,?)")
  .run(await bcrypt.hash("forge", 10), ts, ts);
db.prepare("INSERT INTO assets (id, org_id, workspace_id, name, type, hierarchy, status, mqtt_topics, opcua_nodes, doc_ids, acl, labels, created_at, updated_at) VALUES ('AS-IMG','ORG-IMG','WS-IMG','Pump-Visual','pump','Atlas/Plant/Pump-Visual','normal','[]','[]','[]','{}','[]',?,?)")
  .run(ts, ts);
// A team space + project so the test document has a parent chain.
db.prepare("INSERT INTO team_spaces (id, org_id, workspace_id, name, summary, status, acl, labels, created_at, updated_at) VALUES ('TS-IMG','ORG-IMG','WS-IMG','Engineering','','active','{}','[]',?,?)").run(ts, ts);
db.prepare("INSERT INTO projects (id, team_space_id, name, status, milestones, acl, labels, created_at, updated_at) VALUES ('PRJ-IMG','TS-IMG','P','active','[]','{}','[]',?,?)").run(ts, ts);
db.prepare("INSERT INTO documents (id, team_space_id, project_id, name, discipline, current_revision_id, sensitivity, acl, labels, created_at, updated_at) VALUES ('DOC-IMG','TS-IMG','PRJ-IMG','Doc','Eng',NULL,'internal','{}','[]',?,?)").run(ts, ts);

const { default: Fastify } = await import("fastify");
const { default: jwt } = await import("@fastify/jwt");
const { default: cors } = await import("@fastify/cors");
const { default: multipart } = await import("@fastify/multipart");
const { userById } = await import("../server/auth.js");

const app = Fastify({ logger: false });
await app.register(cors, { origin: true });
await app.register(jwt, { secret: process.env.FORGE_JWT_SECRET });
// Multipart cap above 25 MB so the route's transcoder cap is the one
// that fires (rather than the multipart parser pre-empting it).
await app.register(multipart, { limits: { fileSize: 30 * 1024 * 1024 } });

app.addHook("onRequest", async (req) => {
  const h = req.headers.authorization || "";
  const tok = h.startsWith("Bearer ") ? h.slice(7) : null;
  req.user = null;
  if (!tok) return;
  try {
    const d = app.jwt.verify(tok);
    if (d?.sub) req.user = userById(d.sub);
  } catch { /* unauthenticated */ }
});

await app.register((await import("../server/routes/files.js")).default);
await app.listen({ port: 0, host: "127.0.0.1" });
const addr = app.server.address();
const base = `http://127.0.0.1:${addr.port}`;

test.after(async () => {
  await app.close();
});

const TOKEN = app.jwt.sign({ sub: "U-IMG" });

test("POST /api/files with parent_kind=asset + AVIF transcodes to WebP primary + JPEG derivative", async () => {
  // Synthetic AVIF — same generator as the unit test. 128 px keeps the
  // encoder fast.
  const png = await sharp({
    create: { width: 128, height: 128, channels: 3, background: { r: 0, g: 100, b: 200 } },
  }).png().toBuffer();
  const avif = await sharp(png).avif({ quality: 60 }).toBuffer();

  const fd = new FormData();
  fd.append("parent_kind", "asset");
  fd.append("parent_id", "AS-IMG");
  fd.append("file", new Blob([avif], { type: "image/avif" }), "pump.avif");

  const up = await fetch(base + "/api/files", {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}` },
    body: fd,
  });
  assert.equal(up.status, 200, "asset visual upload returns 200");
  const meta = await up.json();

  // Primary row is WebP.
  assert.equal(meta.mime, "image/webp", "primary mime is image/webp");
  assert.ok(meta.id && meta.id.startsWith("F"), "primary id is a file id");
  assert.ok(meta.sha256 && meta.sha256.length === 64, "primary sha256 is 64 hex chars");
  assert.ok(meta.name?.endsWith(".webp"), "primary name has .webp extension");
  assert.ok(meta.size > 0, "primary size > 0");

  // Derivative is JPEG and points at a distinct file id.
  assert.ok(meta.derivative, "response carries derivative");
  assert.equal(meta.derivative.mime, "image/jpeg", "derivative mime is image/jpeg");
  assert.ok(meta.derivative.id && meta.derivative.id !== meta.id, "derivative id distinct from primary");
  assert.ok(meta.derivative.sha256 && meta.derivative.sha256.length === 64, "derivative sha256 is 64 hex chars");
  assert.ok(meta.derivative.name?.endsWith(".jpg"), "derivative name has .jpg extension");
  assert.ok(meta.derivative.size > 0, "derivative size > 0");

  // Source metadata is exposed so callers can correlate.
  assert.ok(meta.source, "response carries source metadata");
  assert.equal(meta.source.mime, "image/avif");
  assert.equal(meta.source.size, avif.length);

  // Round-trip: download both ids and confirm bytes decode as their
  // stated formats. Catches a class of regressions where the DB row
  // and on-disk bytes disagree on MIME.
  const webpDl = await fetch(base + "/api/files/" + meta.id, { headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(webpDl.status, 200);
  assert.equal(webpDl.headers.get("content-type"), "image/webp");
  const webpBytes = Buffer.from(await webpDl.arrayBuffer());
  assert.equal((await sharp(webpBytes).metadata()).format, "webp");

  const jpegDl = await fetch(base + "/api/files/" + meta.derivative.id, { headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(jpegDl.status, 200);
  assert.equal(jpegDl.headers.get("content-type"), "image/jpeg");
  const jpegBytes = Buffer.from(await jpegDl.arrayBuffer());
  assert.equal((await sharp(jpegBytes).metadata()).format, "jpeg");
});

test("POST /api/files rejects HEIC/AVIF for non-asset parent_kind (415)", async () => {
  const png = await sharp({
    create: { width: 64, height: 64, channels: 3, background: { r: 50, g: 50, b: 50 } },
  }).png().toBuffer();
  const avif = await sharp(png).avif({ quality: 50 }).toBuffer();

  const fd = new FormData();
  fd.append("parent_kind", "document");
  fd.append("parent_id", "DOC-IMG");
  fd.append("file", new Blob([avif], { type: "image/avif" }), "doc.avif");

  const up = await fetch(base + "/api/files", {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}` },
    body: fd,
  });
  assert.equal(up.status, 415, "non-asset HEIC/AVIF upload returns 415");
  const body = await up.json();
  assert.match(body.error, /HEIC|AVIF/i);
});

test("POST /api/files leaves PNG uploads untouched on asset parent_kind", async () => {
  // Regression: asset uploads of formats outside the transcode set
  // must still go through the original code path (single file row,
  // no derivative).
  const png = await sharp({
    create: { width: 32, height: 32, channels: 3, background: { r: 10, g: 20, b: 30 } },
  }).png().toBuffer();

  const fd = new FormData();
  fd.append("parent_kind", "asset");
  fd.append("parent_id", "AS-IMG");
  fd.append("file", new Blob([png], { type: "image/png" }), "pump.png");

  const up = await fetch(base + "/api/files", {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}` },
    body: fd,
  });
  assert.equal(up.status, 200);
  const meta = await up.json();
  assert.equal(meta.mime, "image/png");
  assert.equal(meta.derivative, undefined, "PNG upload has no derivative");
  assert.equal(meta.source, undefined, "PNG upload has no source metadata");
});
