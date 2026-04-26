#!/usr/bin/env node
// Local release archive packer. Mirrors the GitHub Actions release flow
// so engineers can produce installable bundles for Windows, macOS, or
// Linux directly from a dev machine without waiting for CI.
//
// Usage:
//   npm run release:archive -- --target linux-x64
//   npm run release:archive -- --target windows-x64 --out ./build
//
// What it does:
//   1. Refuses to run unless dist/ exists (run `npm run build` first).
//   2. Stages a clean copy of the runtime files in build/forge-<ver>-<target>/.
//   3. Strips dev source maps to halve the disk footprint.
//   4. Emits forge-<ver>-<target>.tar.gz (Linux/macOS) or .zip (Windows)
//      next to the staging directory, and a SHA-256 / SHA-512 manifest.
//
// The matrix CI workflow uses the same staging layout — keep them in sync.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

const args = parseArgs(process.argv.slice(2));
const target = args.target || autodetectTarget();
const outDir = path.resolve(args.out || "build");
const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname);
const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
const version = args.version || pkg.version;

if (!fs.existsSync(path.join(repoRoot, "dist", "index.html"))) {
  die("dist/ missing — run `npm run build` first");
}

const stagingName = `forge-${version}-${target}`;
const stagingDir = path.join(outDir, stagingName);

console.log(`==> Packing ${stagingName}`);
fs.rmSync(stagingDir, { recursive: true, force: true });
fs.mkdirSync(stagingDir, { recursive: true });

const dirsToCopy = ["dist", "server", "src", "docs", "scripts", "config"];
for (const d of dirsToCopy) {
  const src = path.join(repoRoot, d);
  if (!fs.existsSync(src)) continue;
  fs.cpSync(src, path.join(stagingDir, d), { recursive: true });
}
const filesToCopy = [
  "index.html", "app.js", "styles.css", "manifest.webmanifest", "icon.svg",
  "package.json", "package-lock.json", "LICENSE", "README.md", "PRODUCT_SPEC.md",
];
for (const f of filesToCopy) {
  const src = path.join(repoRoot, f);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(stagingDir, f));
}

console.log("==> Pruning to production dependencies in staging");
spawnAt(stagingDir, "npm", ["ci", "--omit=dev", "--no-audit", "--no-fund"]);
// node_modules is now production-only.

console.log("==> Stripping source maps");
walk(path.join(stagingDir, "dist"), (p) => {
  if (p.endsWith(".map")) fs.rmSync(p);
});

console.log("==> Adding launcher scripts");
fs.writeFileSync(path.join(stagingDir, "start.sh"),
  "#!/usr/bin/env bash\nset -euo pipefail\ncd \"$(dirname \"$0\")\"\nexec node server/main.js\n",
  { mode: 0o755 });
fs.writeFileSync(path.join(stagingDir, "start.cmd"),
  "@echo off\r\ncd /d %~dp0\r\nnode server\\main.js\r\n");

const ext = target.startsWith("windows") ? "zip" : "tar.gz";
const archiveName = `${stagingName}.${ext}`;
const archivePath = path.join(outDir, archiveName);

console.log(`==> Producing ${archiveName}`);
if (ext === "tar.gz") {
  spawnAt(outDir, "tar", ["-czf", archiveName, stagingName]);
} else {
  // Windows zip — `zip` is on macOS/Linux too; PowerShell `Compress-Archive`
  // is the cross-platform fallback.
  if (commandExists("zip")) {
    spawnAt(outDir, "zip", ["-rq", archiveName, stagingName]);
  } else if (process.platform === "win32") {
    spawnAt(outDir, "powershell", [
      "-Command",
      `Compress-Archive -Path ${stagingName} -DestinationPath ${archiveName} -Force`,
    ]);
  } else {
    die("`zip` not found. Install zip or run on Windows for .zip output.");
  }
}

// Checksums.
const buf = fs.readFileSync(archivePath);
const sha256 = crypto.createHash("sha256").update(buf).digest("hex");
const sha512 = crypto.createHash("sha512").update(buf).digest("hex");
fs.writeFileSync(archivePath + ".sha256", `${sha256}  ${archiveName}\n`);
fs.writeFileSync(archivePath + ".sha512", `${sha512}  ${archiveName}\n`);

console.log("==> Done");
console.log("    archive: " + archivePath);
console.log("    sha256:  " + sha256);
console.log("    sha512:  " + sha512);

// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--target") out.target = argv[++i];
    else if (a === "--out") out.out = argv[++i];
    else if (a === "--version") out.version = argv[++i];
    else if (a === "--help" || a === "-h") { console.log(usage()); process.exit(0); }
  }
  return out;
}
function usage() {
  return `forge release:archive
  --target {linux-x64|macos-arm64|macos-x64|windows-x64}  default: autodetect
  --out PATH                                              default: ./build
  --version VERSION                                       default: package.json
`;
}
function autodetectTarget() {
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  if (process.platform === "linux")  return `linux-${arch === "arm64" ? "arm64" : "x64"}`;
  if (process.platform === "darwin") return `macos-${arch === "arm64" ? "arm64" : "x64"}`;
  if (process.platform === "win32")  return "windows-x64";
  die(`unsupported platform ${process.platform}/${process.arch}`);
}
function spawnAt(cwd, cmd, args) {
  const r = spawnSync(cmd, args, { cwd, stdio: "inherit", shell: process.platform === "win32" });
  if (r.status !== 0) die(`${cmd} ${args.join(" ")} failed`);
}
function commandExists(c) {
  const r = spawnSync(process.platform === "win32" ? "where" : "which", [c], { stdio: "ignore" });
  return r.status === 0;
}
function walk(dir, fn) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, fn);
    else fn(p);
  }
}
function die(msg) { console.error("error: " + msg); process.exit(2); }
