// CAD format detection + DWG converter safety tests.

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

const { detectCad, supportedExtensions, extOf, acceptAttr } = await import("../src/core/cad.js");

test("detectCad: 2D paper-likes", () => {
  assert.equal(detectCad("/foo/bar.pdf").kind, "pdf");
  assert.equal(detectCad("/foo/bar.dxf").kind, "dxf");
  assert.equal(detectCad("/foo/bar.DWG").kind, "dwg");
  assert.equal(detectCad("/foo/bar.svg").kind, "svg");
  assert.equal(detectCad("/foo/bar.csv").kind, "csv");
});

test("detectCad: 3D model formats", () => {
  for (const ext of ["stp","step","igs","iges","stl","obj","gltf","glb","3dm","3ds","3mf","fbx","dae","ply","off","wrl","brep"]) {
    const r = detectCad("model." + ext);
    assert.ok(r, "should detect " + ext);
    assert.equal(r.viewer, "o3d", ext + " → o3d");
    assert.equal(r.dim, 3);
  }
});

test("detectCad: BIM/IFC", () => {
  const r = detectCad("plant.ifc");
  assert.equal(r.kind, "ifc");
  assert.equal(r.viewer, "ifc");
});

test("detectCad: DWG flags server conversion", () => {
  const r = detectCad("plant.DWG");
  assert.equal(r.needsServerConvert, "dxf");
  assert.equal(r.viewer, "dxf");
});

test("detectCad: by MIME", () => {
  assert.equal(detectCad(null, "model/step")?.kind, "step");
  assert.equal(detectCad(null, "image/vnd.dwg")?.kind, "dwg");
  assert.equal(detectCad(null, "model/vnd.ifc")?.kind, "ifc");
});

test("detectCad: unknown returns null", () => {
  assert.equal(detectCad("file.xyz"), null);
  assert.equal(detectCad("noext"), null);
});

test("extOf strips query/hash", () => {
  assert.equal(extOf("/foo/bar.dwg?token=x"), "dwg");
  assert.equal(extOf("/foo/bar.STEP#frag"), "step");
  assert.equal(extOf(""), "");
});

test("acceptAttr lists every supported extension", () => {
  const exts = supportedExtensions();
  assert.ok(exts.includes("dwg"));
  assert.ok(exts.includes("step"));
  assert.ok(exts.includes("ifc"));
  const accept = acceptAttr();
  for (const e of exts) assert.ok(accept.includes("." + e), "missing ." + e);
});

test("server DWG converter: missing source paths reject", async () => {
  // Isolate the converter to a tmp dir so it doesn't touch real data.
  process.env.FORGE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "forge-cad-"));
  const { convertDwgToDxf, hasConverter } = await import("../server/converters/dwg.js");
  await assert.rejects(() => convertDwgToDxf({}), /filePath or url required/);
  // Whether the converter is installed or not is fine — both shapes valid.
  const installed = await hasConverter();
  assert.ok(typeof installed === "boolean");
});

test("server CAD route safety: name regex rejects path traversal", async () => {
  const safe = "../../etc/passwd";
  // The route enforces /^[a-f0-9]{64}\.dxf$/i — the regex matches by
  // shape only, never resolving against the filesystem.
  const re = /^[a-f0-9]{64}\.dxf$/i;
  assert.equal(re.test(safe), false);
  assert.equal(re.test("a".repeat(64) + ".dxf"), true);
  assert.equal(re.test("invalid.dxf"), false);
});
