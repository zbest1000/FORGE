# FORGE — Licensing

FORGE ships with a built-in, offline-verifiable licensing system. The
goal is to support a clean modular product story — **community**,
**personal**, **team**, and **enterprise** editions on either
**annual** or **perpetual** terms — without ever phoning home and
without depending on a vendor server being reachable from the
customer's network.

This document covers:

- [Editions and feature catalog](#editions-and-feature-catalog)
- [License lifecycle](#license-lifecycle)
- [How to install a license](#how-to-install-a-license)
- [How verification works](#how-verification-works)
- [Vendor key management](#vendor-key-management)
- [Issuing licenses (`forge-license` CLI)](#issuing-licenses-forge-license-cli)
- [Operating model](#operating-model)

## Editions and feature catalog

Each tier maps to a starting-point feature list (`TIER_DEFAULTS` in
`server/license.js`). A specific license can override that default by
adding or removing individual features — useful for promotional bundles
and per-customer deals.

| Feature                              | community | personal | team | enterprise |
| ------------------------------------ | :-------: | :------: | :--: | :--------: |
| Core auth / docs / team spaces       |     ●     |    ●     |  ●   |     ●      |
| Audit log view + tamper check        |     ●     |    ●     |  ●   |     ●      |
| Search                               |     ●     |    ●     |  ●   |     ●      |
| PDF viewer / Mermaid diagrams        |     ●     |    ●     |  ●   |     ●      |
| 3D viewer (three.js)                 |           |    ●     |  ●   |     ●      |
| CAD viewer / DWG conversion          |           |    ●†    |  ●   |     ●      |
| BIM/IFC viewer (web-ifc)             |           |    ●     |  ●   |     ●      |
| Review cycles, RFI links, forms      |           |    ●     |  ●   |     ●      |
| Commissioning checklists             |           |          |  ●   |     ●      |
| MQTT bridge / UNS / i3X API          |           |          |  ●   |     ●      |
| OPC UA bridge                        |           |          |      |     ●      |
| Webhooks / n8n automations / AI      |           |          |  ●   |     ●      |
| GraphQL API                          |           |          |  ●   |     ●      |
| Audit-pack export / retention        |           |          |  ●   |     ●      |
| Compliance console                   |           |          |      |     ●      |
| SSO (SAML/OIDC) / SCIM / MFA enforce |           |          |      |     ●      |
| Prometheus / OpenTelemetry / HA      |           |     ⚪    |  ●prom |  all     |

*● = included; ⚪ = via `features.add`; † = `personal` includes the
viewer but not DWG → DXF conversion.*

The authoritative feature catalog is `FEATURES` in
`server/license.js` and `src/core/license.js` — the same list is
exposed at `GET /api/license/catalog` for the admin UI.

### Default seat counts

| Tier        | Seats (default) | Hard cap | Term modes        |
| ----------- | --------------: | -------: | ----------------- |
| community   | 3               | 5        | perpetual only    |
| personal    | 1               | 1        | annual            |
| team        | 25              | 30 (10%) | annual, perpetual |
| enterprise  | unlimited       | ∞        | annual, perpetual |

`hard cap` is a soft-warn → hard-block window so an organisation can
on-board a temporary contractor without an immediate licensing escalation;
once the hard cap is hit, new users cannot be created until either a seat
is freed or the license is upgraded.

## License lifecycle

A FORGE license is a single string:

```
forge1.<base64url(canonical-payload)>.<base64url(ed25519-signature)>
```

| Field                | Meaning                                                              |
| -------------------- | -------------------------------------------------------------------- |
| `license_id`         | Vendor-assigned identifier (e.g. `FRG-9C3F2A`).                      |
| `customer`           | Display string (printed in the admin license panel and in audit).    |
| `tier`               | `community` / `personal` / `team` / `enterprise`.                    |
| `edition`            | Free-form display string; defaults to `tier`.                        |
| `term`               | `annual` (sets `expires_at`) or `perpetual`.                         |
| `seats`              | Licensed maximum of *enabled* users.                                 |
| `issued_at`          | Vendor signing timestamp.                                            |
| `starts_at`          | Earliest date the license is valid.                                  |
| `expires_at`         | Annual term only. After expiry the install downgrades to community.  |
| `maintenance_until`  | Perpetual term only. Eligibility for new releases.                   |
| `features.add[]`     | Features added on top of `TIER_DEFAULTS[tier]`.                      |
| `features.remove[]`  | Features removed from the tier default.                              |
| `deployment`         | `self_hosted` or `cloud`. Informational; not enforced at runtime.    |
| `notes`              | Free-form notes shown in the admin panel.                            |

### Annual vs perpetual

- **Annual**: `expires_at` set; on the day after expiry the running
  installation materialises as community-tier (paid features 402, data
  remains readable). Renewing simply replaces the token.
- **Perpetual**: `expires_at = null`; the license never lapses.
  `maintenance_until` controls eligibility for future builds — it is
  surfaced in the admin UI and in the boot log, but not enforced at
  runtime. (The `forge-license inspect` CLI flags expired maintenance
  for compliance reporting.)

## How to install a license

The active license is resolved in this order:

1. Token stored in the SQLite database (set via `POST /api/license` from
   the admin UI). **Recommended** for self-hosted installs.
2. `FORGE_LICENSE` environment variable (recommended for k8s and
   container orchestration).
3. `license.txt` file inside `FORGE_DATA_DIR` (recommended for system
   service deployments — same place as `forge.db`).
4. None of the above → **community** fallback.

### From the admin UI

1. Sign in as **Organization Owner**.
2. Navigate to **Admin → License**.
3. Paste the `forge1.…` token into the install textarea.
4. Click **Install / replace**.

The license is recorded in the audit ledger
(`license.install` / `license.uninstall`).

### From the environment

Containerised / cloud deployments:

```yaml
# docker-compose.yml
services:
  forge:
    environment:
      FORGE_LICENSE: "forge1.eyJ..."
```

```yaml
# Kubernetes (commit-safe via secret reference)
env:
  - name: FORGE_LICENSE
    valueFrom:
      secretKeyRef:
        name: forge-license
        key: token
```

### From a file

```bash
# next to your data directory (default: $REPO/data/license.txt)
echo "forge1.eyJ..." > /var/lib/forge/license.txt
chmod 600 /var/lib/forge/license.txt
```

## How verification works

- The vendor signs the canonicalised payload bytes with an Ed25519
  private key. Canonicalisation is stable key-order JSON
  (`server/crypto.js → canonicalJSON`) so re-encoding the payload never
  invalidates the signature.
- FORGE verifies with the matching public key bundled at build time
  (`config/license-pubkey.pem`), or whatever PEM is supplied in the
  `FORGE_LICENSE_PUBLIC_KEY` environment variable.
- Verification is purely local — no network call, no telemetry, no
  callback to a vendor service. The license module is import-safe so
  it works in tests, the `forge-license` CLI, and the running server.

## Vendor key management

The repository ships with a **development** keypair so unit tests and
the bundled `--dev-key` CLI flag can produce verifiable tokens without
external state. **Production vendors must replace this keypair before
distributing a fork**:

```bash
# 1. Generate vendor keys
node scripts/license/keygen.js --out vendor

# 2. Install the public half into the FORGE binary
cp vendor-pub.pem config/license-pubkey.pem

# 3. Store the private half in your vendor secrets manager
#    (1Password, Vault, AWS Secrets Manager, etc.).
#    NEVER commit the private key.

# 4. Rebuild and redistribute
npm run build
```

Self-hosted customers running their own forks can override the bundled
public key without rebuilding by setting:

```bash
export FORGE_LICENSE_PUBLIC_KEY="$(cat vendor-pub.pem)"
```

## Issuing licenses (`forge-license` CLI)

```bash
# Issue a 2-year team license, 25 seats, signed with vendor private key
node scripts/license/issue.js \
  --customer "Acme Corp" \
  --contact  "billing@acme.example" \
  --tier     team \
  --term     annual --years 2 \
  --seats    25 \
  --priv-key vendor-priv.pem
# → forge1.eyJ...

# Inspect any token (works on prod files via stdin)
cat /var/lib/forge/license.txt | node scripts/license/inspect.js --file -

# Issue a perpetual enterprise license with a feature held back
node scripts/license/issue.js \
  --customer "Industrial Ops" \
  --tier     enterprise \
  --term     perpetual \
  --maintenance 3 \
  --seats    250 \
  --remove   industrial.opcua \
  --priv-key vendor-priv.pem
```

Convenience npm aliases:

```bash
npm run license:keygen   # ed25519 keypair
npm run license:issue -- --customer Foo --dev-key ...
npm run license:inspect -- --token "forge1.…"
```

## Operating model

- **Audit**: every `install` / `uninstall` is recorded in the existing
  HMAC-chained audit ledger so a security review can prove which
  Organization Owner activated which license and when.
- **No phone home**: FORGE never makes outbound network requests for
  licensing. Air-gapped installs are first-class.
- **Soft warnings**: on every successful boot the active license is
  logged at `INFO` level (source / customer / tier / status / feature
  count). Within 30 days of expiry, a structured warning reason
  (`expires_in_<n>_days`) appears both in the API response and the
  admin banner.
- **Recovery**: deleting the license token from `meta.license_token`
  (or restarting without `FORGE_LICENSE` / `license.txt`) drops the
  installation back to community. No data is lost; just paid features
  fail closed.
- **Provenance**: container images are signed via cosign keyless and
  carry a build-provenance attestation. See `docs/RELEASE.md` for the
  verification command.
