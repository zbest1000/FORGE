# FORGE — Licensing

FORGE ships with a three-tier license activation system designed
around two principles:

1. **Online activation, then offline operation.** A FORGE installation
   only needs the internet *once* — to activate. After that it runs
   entirely from the cached, signed activation token. The local
   license server still heartbeats once a day (best-effort) so the
   customer learns promptly when a seat has been moved or released,
   but a network outage never takes a working installation down.
2. **Last-writer-wins seat ownership.** A license with `seats: N`
   permits N concurrent activations. When a customer activates the
   same license on a new machine and N is already full, the oldest
   activation is **superseded** — the previous machine, on its next
   heartbeat, learns it no longer holds a seat and drops to the
   Community plan. The customer can also voluntarily **release** an
   activation back to the pool to free a seat for use elsewhere, and
   FORGE LLC operators can reclaim a seat for a customer whose
   machine is unreachable (lost laptop, dead server).

```
┌────────────────────────────┐  HTTPS, vendor activation key  ┌────────────────────────────┐
│ FORGE LLC central server   │ ◄──────────────────────────── │ Customer local LS sidecar  │
│ (Ed25519 signing key)      │ ──────────────────────────►   │ (per-customer install)     │
└────────────────────────────┘  long-lived signed             └────────────────────────────┘
                                activation token                              ▲
                                                                              │ HTTPS / LAN
                                                                              │ shared-secret
                                                                   ┌──────────┴───────────┐
                                                                   │ FORGE app instances  │
                                                                   │ (1..N replicas)      │
                                                                   └──────────────────────┘
```

This document covers:

- [Editions and feature catalog](#editions-and-feature-catalog)
- [Activation lifecycle](#activation-lifecycle)
- [Online activation](#online-activation-recommended)
- [Releasing a seat](#releasing-a-seat)
- [Reclaiming a seat (lost laptop)](#reclaiming-a-seat-lost-laptop)
- [Offline activation (air-gapped)](#offline-activation-air-gapped)
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

The 38-entry feature catalog is the single source of truth in
`server/license.js → FEATURE_CATALOG`. Every flag carries an English
display name, a category, a one-sentence description, and a tier
floor. The customer-facing UI **never** shows raw flag ids.

A specific license can override the tier defaults via
`features.add[]` and `features.remove[]`.

## Activation lifecycle

Each activation row on the central server has one of these statuses:

| Status        | When it's set                                                                                                        |
| ------------- | -------------------------------------------------------------------------------------------------------------------- |
| `active`      | Most recent successful `/activate` from this `instance_id`. Holds a seat.                                            |
| `superseded`  | Another machine activated and the seat budget was full — last-writer-wins.                                           |
| `released`    | Customer-initiated voluntary release, OR operator-initiated reclaim. Seat returned to the pool.                       |
| `revoked`     | Operator anti-piracy / fraud action. Cannot be reused without operator intervention.                                  |

The FORGE app downgrades to the Community plan whenever its current
activation enters `superseded`, `released`, or `revoked`.

A `released` or `superseded` row can be reused: re-running activation
from the same `instance_id` flips it back to `active` and a fresh
token is signed.

## Online activation (recommended)

### One-time setup

1. **FORGE LLC creates a customer record** on their central license
   server and gives you two secrets:
   - `customer_id` — opaque (`CUST-…`).
   - `activation_key` — bearer secret (`fla_…`). Treat like a database
     password.

2. **You deploy the local license server** (`services/local-license/`)
   on your network with these env vars:

   ```bash
   FORGE_LLC_URL=https://license.forge.llc          # vendor URL
   FORGE_CUSTOMER_ID=CUST-…
   FORGE_ACTIVATION_KEY=fla_…
   LOCAL_LS_SHARED_TOKEN=$(openssl rand -hex 32)    # used by FORGE on the LAN
   LOCAL_LS_HEARTBEAT_S=86400                       # once a day; 0 to disable
   ```

   The local LS calls `POST /api/v1/activate` against the central
   server on first boot, caches the resulting signed token to disk,
   and serves it on `:7200/api/v1/entitlement`. Subsequent reboots
   of the local LS reuse the cached token and never touch the
   internet — the daily heartbeat is best-effort.

3. **You point each FORGE app instance at the local LS:**

   ```bash
   FORGE_LOCAL_LS_URL=http://forge-license.lan:7200
   FORGE_LOCAL_LS_TOKEN=<the LOCAL_LS_SHARED_TOKEN>
   FORGE_EXPECTED_CUSTOMER_ID=CUST-…                # optional, recommended
   ```

   The FORGE app pulls the activation token once at boot, verifies
   it locally, and persists it under `$FORGE_DATA_DIR/activation.json`.
   On reboot, FORGE reads the file and runs at full entitlement
   without ever contacting the local LS — exactly like an offline
   token, except that the next daily heartbeat will pick up any
   supersession or release that has happened in the meantime.

### What activation requires

- **Local LS → FORGE LLC central server**: outbound HTTPS at
  activation, release, and once a day for heartbeat. Required to be
  online when the customer first activates and when they release a
  seat. Never required during steady-state operation.
- **FORGE app → Local LS**: HTTP/HTTPS on the LAN. Used once on first
  boot to fetch the token, then once a day to refresh the heartbeat
  status. **Not required** to bring up the FORGE app at all once the
  activation is persisted.
- **Wall clock**: the FORGE app refuses tokens whose `issued_at` is
  more than 24 hours in the future to detect clock-back tampering,
  and treats any token whose `license_expires_at` has passed as
  expired. **No central time service is contacted** — the FORGE app
  trusts its own system clock.

## Releasing a seat

A user can transfer their seat to a different machine without
contacting FORGE LLC support:

1. On the **source** machine, open **Admin → License** and click
   **"Release this seat"**. Confirm the dialog. The seat returns to
   the pool; this installation drops to the Community plan
   immediately.
2. On the **destination** machine, run a fresh local LS (with the
   same `FORGE_CUSTOMER_ID` and `FORGE_ACTIVATION_KEY`) and click
   **"Activate"** in **Admin → License**. The seat is now bound to
   the new machine.

If the source machine is later reconnected to the network, its
heartbeat will report `released` (or `superseded`, depending on
ordering) and the UI will guide the user to either reactivate (if a
seat is still free) or accept the Community downgrade.

## Reclaiming a seat (lost laptop)

When the customer cannot reach a machine that holds an activation —
typical scenarios are a lost laptop, a dead server, or a corrupted
filesystem — the FORGE LLC operator can release the activation
remotely:

```bash
# As FORGE LLC staff
node services/license-server/scripts/admin.js list-activations \
  --customer CUST-… --status active

node services/license-server/scripts/admin.js release-activation \
  --activation ACT-… --reason "lost laptop"
```

The seat is now free for the customer to reuse on a new machine.
Both the release and the operator's identity are recorded in the
audit log.

## Offline activation (air-gapped)

For genuinely air-gapped customers there is no central-server
contact at any point. Issue a long-lived `forge1.<payload>.<sig>`
token via `npm run license:issue`, paste it into **Admin → License
→ Install activation token**, and FORGE verifies it locally against
the same vendor public key.

Air-gapped tokens are issued per machine; there is no automatic
reclaim. Renewal is the same loop with a fresh token.

## How verification works

- All tokens (`forge1.*` for offline, `entitlement1.*` for online
  activation) are signed with **Ed25519** (`node:crypto`).
- The matching public key is bundled at build time
  (`config/license-pubkey.pem`) and overridable via
  `FORGE_LICENSE_PUBLIC_KEY`.
- Verification happens at the local LS (defends against a tampered
  central server) AND at the FORGE app (defends against a swapped
  local LS).
- The activation token embeds a `bound_fingerprint` derived from the
  host's platform + hostname hash. The FORGE app refuses to honour a
  token whose fingerprint doesn't match. Set
  `FORGE_SKIP_FINGERPRINT=1` to disable this for ephemeral container
  deployments where the hostname changes on every restart.
- `FORGE_EXPECTED_CUSTOMER_ID` adds defence in depth: the FORGE app
  refuses any token whose `customer_id` doesn't match the expected
  value.
- The FORGE app refuses tokens whose `issued_at` is more than 24
  hours in the future (clock-back tampering defence).

## Vendor key management

The repository ships with FORGE LLC's **development** keypair so unit
tests and end-to-end smoke runs are deterministic. **Forks
distributing FORGE under their own brand must replace this keypair**
before distribution:

```bash
node scripts/license/keygen.js --out vendor
cp vendor-pub.pem config/license-pubkey.pem        # bundle into FORGE
# install vendor-priv.pem on the central server only,
# referenced via FORGE_LICENSE_SIGNING_KEY_PATH

npm run build
```

## Operator CLI cheat sheet

```bash
# Public key (so customers can match it to their bundled key)
node services/license-server/scripts/admin.js print-pubkey

# Customer + key + license
node services/license-server/scripts/admin.js create-customer --name "Acme"
node services/license-server/scripts/admin.js create-key       --customer CUST-…
node services/license-server/scripts/admin.js create-license   --customer CUST-… \
     --tier enterprise --term annual --years 2 --seats 50

# Activations
node services/license-server/scripts/admin.js list-activations    --customer CUST-…
node services/license-server/scripts/admin.js list-activations    --customer CUST-… --status active
node services/license-server/scripts/admin.js release-activation  --activation ACT-… --reason "lost laptop"
node services/license-server/scripts/admin.js revoke-activation   --activation ACT-… --reason "fraud"

# Customer view
node services/license-server/scripts/admin.js show-customer       --customer CUST-…
```

A remote operator API is also available at `:7100/admin/v1/*` guarded
by `OPERATOR_API_TOKEN` for tooling integration.

## Local development quick start

```bash
# 1. Generate a dev signing keypair (private half stays on the host)
node scripts/license/keygen.js --out services/license-server/central
chmod 600 services/license-server/central-priv.pem

# 2. Boot just the central server
docker compose -f services/docker-compose.licensing.yml up -d central-license

# 3. Provision a test customer
docker compose -f services/docker-compose.licensing.yml exec central-license \
  node scripts/admin.js create-customer --name "Dev"
docker compose -f services/docker-compose.licensing.yml exec central-license \
  node scripts/admin.js create-key --customer CUST-…
docker compose -f services/docker-compose.licensing.yml exec central-license \
  node scripts/admin.js create-license --customer CUST-… \
    --tier enterprise --term annual --years 1 --seats 25

# 4. Configure secrets
cat > services/.env <<EOF
FORGE_CUSTOMER_ID=CUST-…
FORGE_ACTIVATION_KEY=fla_…
LOCAL_LS_SHARED_TOKEN=$(openssl rand -hex 32)
FORGE_TENANT_KEY=$(openssl rand -hex 32)
FORGE_JWT_SECRET=$(openssl rand -hex 32)
FORGE_LICENSE_PUBLIC_KEY="$(cat services/license-server/central-pub.pem)"
EOF

# 5. Bring up the stack
docker compose --env-file services/.env -f services/docker-compose.licensing.yml up -d
```

## Troubleshooting

| Symptom                                                             | Likely cause + fix                                                                                                                |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Banner: "This installation hasn't activated yet"                    | First boot before activation succeeded. Click **Activate** in Admin → License, or check FORGE_LOCAL_LS_URL / shared token / firewall. |
| Banner: "This license has been activated on another machine"        | Last-writer-wins kicked in. Click **Reactivate** to take the seat back here, or accept the Community plan.                          |
| Banner: "This activation has been released to the seat pool"        | Either the user clicked Release here, or the operator did. Click **Reactivate** to use the license here again.                    |
| Banner: "This activation was revoked by your FORGE LLC operator"    | Anti-piracy / fraud action. Contact your FORGE LLC account manager.                                                               |
| Banner: "This activation was issued for a different host"           | The persisted activation file was copied from a different machine. Click **Reactivate** here.                                     |
| Banner: "The system clock appears to have been moved backward"      | Wall clock has been set to before the token's issued_at. Fix the clock and reactivate.                                            |
| Activation log says `customer_disabled` (HTTP 403)                  | Customer account is disabled in the central server. Contact FORGE LLC.                                                            |
| Activation log says `license_expired` (HTTP 410)                    | Annual license expired. Renew via the FORGE LLC portal.                                                                           |
| `FORGE_EXPECTED_CUSTOMER_ID` mismatch                               | Local LS is provisioned for a different customer than the FORGE app expects. Investigate before using.                            |
