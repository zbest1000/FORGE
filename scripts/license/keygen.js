#!/usr/bin/env node
// Generate an Ed25519 keypair for signing FORGE licenses.
//
// Usage:
//   node scripts/license/keygen.js              # PEM, both halves
//   node scripts/license/keygen.js --raw        # raw base64url, both halves
//   node scripts/license/keygen.js --out PATH   # write to PATH-pub.pem / PATH-priv.pem
//
// The private key MUST stay on the vendor side. Distribute the public
// key with the FORGE build (see `config/license-pubkey.pem`).

import crypto from "node:crypto";
import fs from "node:fs";

const args = parseArgs(process.argv.slice(2));
const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");

if (args.raw) {
  const pubRaw = publicKey.export({ format: "der", type: "spki" }).slice(-32);
  const privRaw = privateKey.export({ format: "der", type: "pkcs8" }).slice(-32);
  console.log("public_key_b64u: " + pubRaw.toString("base64url"));
  console.log("private_key_b64u: " + privRaw.toString("base64url"));
} else if (args.out) {
  fs.writeFileSync(args.out + "-pub.pem", publicKey.export({ type: "spki", format: "pem" }));
  fs.writeFileSync(args.out + "-priv.pem", privateKey.export({ type: "pkcs8", format: "pem" }));
  fs.chmodSync(args.out + "-priv.pem", 0o600);
  console.log("wrote", args.out + "-pub.pem", "and", args.out + "-priv.pem (chmod 600)");
} else {
  process.stdout.write(publicKey.export({ type: "spki", format: "pem" }));
  process.stdout.write(privateKey.export({ type: "pkcs8", format: "pem" }));
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--raw") out.raw = true;
    else if (a === "--out") out.out = argv[++i];
    else if (a === "--help" || a === "-h") {
      console.log(`forge-license keygen
  --raw         emit base64url of the raw 32-byte keys
  --out PATH    write PATH-pub.pem and PATH-priv.pem (chmod 600)`);
      process.exit(0);
    }
  }
  return out;
}
