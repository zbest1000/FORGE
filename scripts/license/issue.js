#!/usr/bin/env node
// Issue (sign) a FORGE license token.
//
// Usage:
//   node scripts/license/issue.js \
//     --customer "Acme Corp" \
//     --tier enterprise \
//     --term annual --years 1 \
//     --seats 50 \
//     --priv-key path/to/forge-priv.pem
//
// Optional flags:
//   --license-id ID        explicit license id; defaults to FRG-<random>
//   --contact email
//   --starts YYYY-MM-DD    license activation date (default: today)
//   --maintenance YEARS    perpetual licenses: years of maintenance from --starts
//   --add  feat            add feature beyond the tier default (repeatable)
//   --remove feat          remove feature from the tier default (repeatable)
//   --deployment self_hosted|cloud
//   --notes "string"
//   --dev-key              sign with the bundled DEV key (TESTING ONLY)
//   --pretty               also print the decoded payload

import fs from "node:fs";
import crypto from "node:crypto";
import { signLicense, DEV_PRIVATE_KEY_PEM, TIERS, FEATURES } from "../../server/license.js";

const args = parseArgs(process.argv.slice(2));
if (!args.customer) die("--customer is required");
const tier = args.tier || "team";
if (!TIERS.includes(tier)) die(`--tier must be one of: ${TIERS.join(", ")}`);
const term = args.term || "annual";
if (!["perpetual", "annual"].includes(term)) die("--term must be perpetual|annual");

const today = new Date();
const startsAt = args.starts ? new Date(args.starts + "T00:00:00Z") : today;
const years = Number(args.years || (term === "annual" ? 1 : 0));
let expiresAt = null;
if (term === "annual") {
  const e = new Date(startsAt);
  e.setUTCFullYear(e.getUTCFullYear() + (years || 1));
  expiresAt = e.toISOString();
}
let maintenanceUntil = null;
if (term === "perpetual" && args.maintenance) {
  const m = new Date(startsAt);
  m.setUTCFullYear(m.getUTCFullYear() + Number(args.maintenance));
  maintenanceUntil = m.toISOString();
}

const featureNames = new Set(Object.values(FEATURES));
const add = (args.add || []).filter(f => featureNames.has(f));
const remove = (args.remove || []).filter(f => featureNames.has(f));

const payload = {
  license_id: args.license_id || ("FRG-" + crypto.randomBytes(6).toString("hex").toUpperCase()),
  customer: args.customer,
  contact: args.contact || null,
  edition: args.edition || tier,
  tier,
  term,
  seats: Number(args.seats || 1),
  issued_at: new Date().toISOString(),
  starts_at: startsAt.toISOString(),
  expires_at: expiresAt,
  maintenance_until: maintenanceUntil,
  features: { add, remove },
  deployment: args.deployment || "self_hosted",
  notes: args.notes || null,
};

let priv;
if (args.dev_key) {
  priv = DEV_PRIVATE_KEY_PEM;
  process.stderr.write("WARNING: signing with the bundled DEV private key. Test only.\n");
} else if (args.priv_key) {
  priv = fs.readFileSync(args.priv_key, "utf8");
} else {
  die("supply --priv-key PATH or --dev-key");
}

const token = signLicense(payload, priv);
process.stdout.write(token + "\n");
if (args.pretty) {
  process.stderr.write("\n--- payload ---\n");
  process.stderr.write(JSON.stringify(payload, null, 2) + "\n");
}

function parseArgs(argv) {
  const out = { add: [], remove: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--customer") out.customer = argv[++i];
    else if (a === "--contact") out.contact = argv[++i];
    else if (a === "--license-id") out.license_id = argv[++i];
    else if (a === "--tier") out.tier = argv[++i];
    else if (a === "--edition") out.edition = argv[++i];
    else if (a === "--term") out.term = argv[++i];
    else if (a === "--years") out.years = argv[++i];
    else if (a === "--seats") out.seats = argv[++i];
    else if (a === "--starts") out.starts = argv[++i];
    else if (a === "--maintenance") out.maintenance = argv[++i];
    else if (a === "--add") out.add.push(argv[++i]);
    else if (a === "--remove") out.remove.push(argv[++i]);
    else if (a === "--deployment") out.deployment = argv[++i];
    else if (a === "--notes") out.notes = argv[++i];
    else if (a === "--priv-key") out.priv_key = argv[++i];
    else if (a === "--dev-key") out.dev_key = true;
    else if (a === "--pretty") out.pretty = true;
    else if (a === "--help" || a === "-h") { console.log(usage()); process.exit(0); }
    else die("unknown arg: " + a);
  }
  return out;
}

function usage() {
  return `forge-license issue
  --customer NAME              (required)
  --contact email
  --license-id ID
  --tier community|personal|team|enterprise   default: team
  --term perpetual|annual                     default: annual
  --years N                                   default: 1
  --seats N                                   default: 1
  --starts YYYY-MM-DD
  --maintenance YEARS                         (perpetual only)
  --add FEATURE                               (repeatable)
  --remove FEATURE                            (repeatable)
  --deployment self_hosted|cloud              default: self_hosted
  --notes "string"
  --priv-key PATH | --dev-key
  --pretty
`;
}

function die(msg) {
  process.stderr.write("error: " + msg + "\n\n" + usage());
  process.exit(2);
}
