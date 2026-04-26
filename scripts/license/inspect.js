#!/usr/bin/env node
// Inspect a FORGE license token and print its decoded payload + verification.
//
// Usage:
//   node scripts/license/inspect.js --token "forge1.…"
//   node scripts/license/inspect.js --file path/to/license.txt
//   node scripts/license/inspect.js --file -                       # stdin
//
// Optional:
//   --pubkey PATH           verify against a specific PEM public key
//   --json                  emit machine-readable JSON
import fs from "node:fs";
import { verifyLicense } from "../../server/license.js";

const args = parseArgs(process.argv.slice(2));
let token = args.token;
if (!token && args.file) {
  token = args.file === "-"
    ? fs.readFileSync(0, "utf8").trim()
    : fs.readFileSync(args.file, "utf8").trim();
}
if (!token) {
  process.stderr.write("error: pass --token TOKEN or --file PATH (or '-' for stdin)\n");
  process.exit(2);
}

let pubkey = null;
if (args.pubkey) {
  const crypto = await import("node:crypto");
  pubkey = crypto.createPublicKey({ key: fs.readFileSync(args.pubkey, "utf8"), format: "pem" });
}

const v = verifyLicense(token, pubkey);
if (args.json) {
  process.stdout.write(JSON.stringify(v, null, 2) + "\n");
  process.exit(v.signature_ok ? 0 : 1);
}

const ok = v.signature_ok ? "VALID" : "INVALID";
process.stdout.write(`signature: ${ok}\n`);
if (v.error) process.stdout.write(`error:     ${v.error}\n`);
if (v.payload) {
  process.stdout.write("payload:\n");
  for (const [k, val] of Object.entries(v.payload)) {
    process.stdout.write(`  ${k}: ${typeof val === "object" ? JSON.stringify(val) : val}\n`);
  }
}
process.exit(v.signature_ok ? 0 : 1);

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--token") out.token = argv[++i];
    else if (a === "--file") out.file = argv[++i];
    else if (a === "--pubkey") out.pubkey = argv[++i];
    else if (a === "--json") out.json = true;
    else if (a === "--help" || a === "-h") {
      console.log("forge-license inspect [--token T | --file P] [--pubkey PEM] [--json]");
      process.exit(0);
    }
  }
  return out;
}
