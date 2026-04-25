// Online backup / restore CLI. Uses SQLite's VACUUM INTO for a consistent
// point-in-time snapshot without interrupting writers, then tars the
// snapshot + the /files directory. Restore is the reverse.
//
// Usage:
//   node server/backup.js backup  [out.tar.gz]
//   node server/backup.js restore <in.tar.gz>

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { db } from "./db.js";
import { audit } from "./audit.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = process.env.FORGE_DATA_DIR || path.join(ROOT, "data");

async function tarCreate(out, srcDir, inputs) {
  return new Promise((resolve, reject) => {
    const p = spawn("tar", ["-czf", out, "-C", srcDir, ...inputs], { stdio: "inherit" });
    p.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`tar exit ${code}`)));
  });
}
async function tarExtract(input, destDir) {
  return new Promise((resolve, reject) => {
    const p = spawn("tar", ["-xzf", input, "-C", destDir], { stdio: "inherit" });
    p.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`tar exit ${code}`)));
  });
}

export async function backup(outPath) {
  outPath = outPath || path.join(ROOT, `forge-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.tar.gz`);
  const tmpDb = path.join(DATA_DIR, ".backup.db");
  if (fs.existsSync(tmpDb)) fs.unlinkSync(tmpDb);
  db.exec(`VACUUM INTO '${tmpDb.replace(/'/g, "''")}'`);
  const inputs = [path.basename(tmpDb)];
  if (fs.existsSync(path.join(DATA_DIR, "files"))) inputs.push("files");
  await tarCreate(outPath, DATA_DIR, inputs);
  fs.unlinkSync(tmpDb);
  const size = fs.statSync(outPath).size;
  audit({ actor: "cli", action: "backup.create", subject: outPath, detail: { size } });
  console.log(`backup written → ${outPath}  (${size} bytes)`);
  return outPath;
}

export async function restore(inPath) {
  if (!fs.existsSync(inPath)) throw new Error("backup file not found: " + inPath);
  // Extract to a temp dir next to DATA_DIR.
  const stage = path.join(DATA_DIR, ".restore");
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(stage, { recursive: true });
  await tarExtract(inPath, stage);
  const candidateDb = fs.readdirSync(stage).find(f => f.endsWith(".db"));
  if (!candidateDb) throw new Error("no .db found in archive");
  // Move aside the current DB and swap in the restored one. Caller must
  // restart the server afterwards.
  const liveDb = path.join(DATA_DIR, "forge.db");
  if (fs.existsSync(liveDb)) fs.renameSync(liveDb, liveDb + ".pre-restore");
  fs.renameSync(path.join(stage, candidateDb), liveDb);
  if (fs.existsSync(path.join(stage, "files"))) {
    const liveFiles = path.join(DATA_DIR, "files");
    if (fs.existsSync(liveFiles)) fs.renameSync(liveFiles, liveFiles + ".pre-restore");
    fs.renameSync(path.join(stage, "files"), liveFiles);
  }
  fs.rmSync(stage, { recursive: true, force: true });
  console.log("restore complete. Please restart the server.");
}

// CLI entry.
if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, arg] = process.argv.slice(2);
  try {
    if (cmd === "backup") { await backup(arg); process.exit(0); }
    else if (cmd === "restore") { await restore(arg); process.exit(0); }
    else { console.error("usage: node server/backup.js [backup [out.tar.gz] | restore <in.tar.gz>]"); process.exit(2); }
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}
