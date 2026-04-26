# FORGE — Licensing

FORGE ships with a three-tier license activation system:

```
┌────────────────────────────┐  HTTPS, vendor API key  ┌────────────────────────────┐
│ FORGE LLC central server   │ ◄────────────────────── │ Customer local LS sidecar  │
│ (vendor side, holds the    │ ──────────────────────► │ (one per customer site)    │
│  Ed25519 signing key)      │  signed entitlement     │                            │
└────────────────────────────┘  bundle (24 h)          └────────────────────────────┘
                                                                    ▲
                                                                    │ HTTPS, LAN-only
                                                                    │ shared-secret
                                                          ┌─────────┴───────────┐
                                                          │ FORGE app instances │
                                                          │ (1..N replicas)     │
                                                          └─────────────────────┘
```

The central server is operated by FORGE LLC. The local license server
is a small, self-hostable Node service that customers run inside their
own network. The FORGE app talks only to the local server — it never
opens an outbound connection to FORGE LLC, which keeps the public-
internet attack surface limited to the one outbound TCP connection per
customer site.

This document covers:

- [Editions and feature catalog](#editions-and-feature-catalog)
- [Online activation flow (recommended)](#online-activation-flow-recommended)
- [Offline activation (air-gapped installs)](#offline-activation-air-gapped-installs)
- [How verification works](#how-verification-works)
- [Vendor key management](#vendor-key-management)
- [Operator CLI cheat sheet](#operator-cli-cheat-sheet)
- [Local development quick start](#local-development-quick-start)
- [Troubleshooting](#troubleshooting)

## Editions and feature catalog

| Plan        | Default seats     | Term modes        | Highlights                                                                                                       |
| ----------- | ----------------: | ----------------- | ---------------------------------------------------------------------------------------------------------------- |
| Community   | 3 (hard cap 5)    | Perpetual         | Core auth, Documents, Team Spaces, Audit log, Search, PDF viewer, Mermaid, UNS browser.                          |
| Personal    | 1 (hard cap 1)    | Annual            | Adds 3D viewer, CAD viewer, BIM/IFC, Review cycles, RFI cross-linking, Forms.                                    |
| Team        | 25 (hard cap 30)  | Annual, Perpetual | Adds DWG → DXF conversion, Commissioning, MQTT bridge, i3X API, Webhooks, AI providers, GraphQL, Audit pack.     |
| Enterprise  | Unlimited         | Annual, Perpetual | All Team features plus OPC UA, ERP connectors, Compliance console, SSO/SCIM/MFA enforce, OTel, HA deployment.    |

Every gated feature carries a stable id (e.g. `industrial.mqtt`), an
English display name, a category, and a one-sentence description.
The authoritative catalog is `FEATURE_CATALOG` in `server/license.js`;
the same shape is exposed at `GET /api/license/catalog`.

The customer-facing UI **never** shows raw flag ids — it always uses
the display name (e.g. *"MQTT bridge"*, *"OPC UA bridge"*,
*"GraphQL API"*) so screen labels, modals, and 402 error toasts read
naturally.

A specific license can override the tier defaults:

- `features.add[]` — add features beyond the tier default.
- `features.remove[]` — remove features from the tier default.

## Online activation flow (recommended)

This is the path for any customer who can reach the public internet.

### One-time setup

1. **FORGE LLC creates a customer record** in their central license
   server and issues you two secrets:
   - A `customer_id` — opaque identifier (e.g. `CUST-9C3F2A`).
   - An `activation_key` — high-entropy bearer secret (e.g.
     `fla_abc123…`). Treat this like a database password: it never
     leaves your network.

2. **You deploy the local license server** (`services/local-license/`)
   on your network with these env vars:

   ```bash
   FORGE_LLC_URL=https://license.forge.llc          # or your private vendor URL
   FORGE_CUSTOMER_ID=CUST-9C3F2A
   FORGE_ACTIVATION_KEY=fla_…
   LOCAL_LS_SHARED_TOKEN=$(openssl rand -hex 32)    # used by FORGE on the LAN
   ```

   The local LS exposes `:7200/api/v1/entitlement` on your LAN.

3. **You point each FORGE app instance at the local LS:**

   ```bash
   FORGE_LOCAL_LS_URL=http://forge-license.lan:7200
   FORGE_LOCAL_LS_TOKEN=<the LOCAL_LS_SHARED_TOKEN>
   FORGE_EXPECTED_CUSTOMER_ID=CUST-9C3F2A           # optional but recommended
   ```

   The FORGE app pulls the current entitlement bundle on boot and
   refreshes every 30 minutes (configurable via
   `FORGE_LOCAL_LS_REFRESH_S`).

### Runtime

- The local license server contacts the FORGE LLC central server every
  hour (configurable: `LOCAL_LS_REFRESH_S`).
- The central server returns a **signed entitlement bundle** valid for
  24 hours.
- The FORGE app verifies every bundle locally with the bundled vendor
  public key. A bundle that fails verification is rejected and never
  cached.
- If FORGE LLC is unreachable, the local LS keeps serving the most
  recent verified bundle (a **grace period**, default **7 days**,
  configurable via `LOCAL_LS_GRACE_HOURS`). Once the grace period
  expires, the FORGE app downgrades to the Community plan.
- If the local LS is unreachable from a FORGE instance, the FORGE
  app reports `status = "not_activated"` until the local LS comes
  back. Paid features fail closed during that window.

### What activation requires from the network

- **Local LS → FORGE LLC central server**: outbound HTTPS to
  `FORGE_LLC_URL` on activation, refresh, and heartbeat. Outbound only,
  one TCP connection at a time, retries on its own. **Required to be
  online when the customer first activates.**
- **FORGE app → Local LS**: HTTP/HTTPS on the LAN, on
  `FORGE_LOCAL_LS_URL`. **Internal traffic only.**

## Offline activation (air-gapped installs)

For genuinely air-gapped customers, FORGE supports a one-shot signed
token issued by FORGE LLC. There is no central server contact at any
point.

1. FORGE LLC issues a `forge1.<payload>.<sig>` token using
   `npm run license:issue` against your air-gapped customer record.
2. The customer pastes the token into **Admin → License → Install
   activation token**, OR sets `FORGE_LICENSE` in the environment, OR
   drops a `license.txt` in `FORGE_DATA_DIR`.
3. The FORGE app verifies the token locally — same Ed25519 vendor
   public key — and uses it for as long as it remains valid.
4. Renewal is the same loop with a freshly issued token.

Air-gapped installs do not benefit from short-lived rotation, so the
support contract typically scopes them with `--term annual` and
explicit renewals.

## How verification works

- All tokens (`forge1.*` for offline, `entitlement1.*` for online
  bundles) are signed with **Ed25519** (`node:crypto`).
- The matching public key is bundled into every FORGE binary and every
  copy of the local LS at build time
  (`config/license-pubkey.pem`). Production deployments override via
  `FORGE_LICENSE_PUBLIC_KEY` if running with a private fork.
- Verification is purely local — both at the local LS (which discards
  any forged bundle from a tampered central server) and at the FORGE
  app (which discards any forged bundle from a swapped local LS).
- `FORGE_EXPECTED_CUSTOMER_ID` adds a defence in depth: if the local
  LS is replaced with a different customer's, the FORGE app refuses
  the bundle even if the signature is valid.

## Vendor key management

The repository ships with FORGE LLC's **development** keypair so unit
tests and end-to-end smoke runs are deterministic. **Forks distributing
FORGE under their own brand must replace this keypair** before
distribution:

```bash
# 1. Generate a vendor keypair
node scripts/license/keygen.js --out vendor

# 2. Install the public half into the FORGE binary + local LS
cp vendor-pub.pem config/license-pubkey.pem

# 3. Install the private half on your central license server only
#    (NEVER commit; store in your secrets manager and reference via
#     FORGE_LICENSE_SIGNING_KEY_PATH).

# 4. Rebuild and redistribute
npm run build
```

## Operator CLI cheat sheet

These commands run on the central license server host. They write
directly to the SQLite db and audit log.

```bash
# Print the public key (so customers can verify it matches their bundled key)
node services/license-server/scripts/admin.js print-pubkey

# Provision a new customer
node services/license-server/scripts/admin.js create-customer \
  --name "Acme Corp" --email billing@acme.example

# Mint an activation key (the raw secret is shown ONCE)
node services/license-server/scripts/admin.js create-key \
  --customer CUST-… --label main

# Issue a license
node services/license-server/scripts/admin.js create-license \
  --customer CUST-… --tier enterprise --term annual --years 2 --seats 100

# Issue a perpetual license with custom feature set
node services/license-server/scripts/admin.js create-license \
  --customer CUST-… --tier team --term perpetual --maintenance 3 \
  --add ops.ha --remove industrial.opcua

# Inspect customer state (license, keys, recent activations)
node services/license-server/scripts/admin.js show-customer --customer CUST-…

# Revoke either side
node services/license-server/scripts/admin.js revoke-key --key KEY-…
node services/license-server/scripts/admin.js revoke-license --license LIC-…
```

A remote operator API is also available at `:7100/admin/v1/*` guarded
by `OPERATOR_API_TOKEN` for tooling integration.

## Local development quick start

A complete three-tier dev stack is available via compose:

```bash
# Generate a dev signing keypair (private half stays on the host)
mkdir -p services/license-server
node scripts/license/keygen.js --out services/license-server/central
chmod 600 services/license-server/central-priv.pem

# Boot just the central server
docker compose -f services/docker-compose.licensing.yml up -d central-license

# Provision a test customer
docker compose -f services/docker-compose.licensing.yml exec central-license \
  node scripts/admin.js create-customer --name "Dev" --email dev@test.example
docker compose -f services/docker-compose.licensing.yml exec central-license \
  node scripts/admin.js create-key --customer CUST-… --label dev
docker compose -f services/docker-compose.licensing.yml exec central-license \
  node scripts/admin.js create-license --customer CUST-… \
    --tier enterprise --term annual --years 1 --seats 25

# Capture the activation key + customer id, then:
cat > services/.env <<EOF
FORGE_CUSTOMER_ID=CUST-…
FORGE_ACTIVATION_KEY=fla_…
LOCAL_LS_SHARED_TOKEN=$(openssl rand -hex 32)
FORGE_TENANT_KEY=$(openssl rand -hex 32)
FORGE_JWT_SECRET=$(openssl rand -hex 32)
FORGE_LICENSE_PUBLIC_KEY="$(cat services/license-server/central-pub.pem)"
EOF

# Bring up the rest of the stack
docker compose --env-file services/.env -f services/docker-compose.licensing.yml up -d
```

## Troubleshooting

| Symptom                                                   | Likely cause + fix                                                                  |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Admin → License shows "Local server unreachable"          | FORGE app can't reach `FORGE_LOCAL_LS_URL`. Check the URL, DNS, and `LOCAL_LS_SHARED_TOKEN`. |
| Admin → License shows "We haven't been able to reach …"   | Local LS lost contact with FORGE LLC for longer than `LOCAL_LS_GRACE_HOURS`. Restore connectivity, then click *Refresh activation now*. |
| 402 errors with "feature_not_licensed"                    | Active license doesn't include that feature. Check `tier_floor` in `/api/license/catalog`. |
| Banner says "License signature didn't verify"             | Public key on the FORGE app doesn't match the central server's signing key. Either set `FORGE_LICENSE_PUBLIC_KEY` or replace `config/license-pubkey.pem`. |
| Activation log says `customer_disabled`                   | The customer's account is disabled in the central server. Contact FORGE LLC support. |
| Activation log says `license_expired` with HTTP 410       | The annual license expired. Renew via the FORGE LLC portal.                          |
| `FORGE_EXPECTED_CUSTOMER_ID` mismatch                     | Local LS is provisioned for a different customer than the FORGE app expects. Investigate before using. |
