# FORGE Licensing — wire protocol

Three components, two protocol hops:

```
┌────────────────────────────┐  HTTPS, vendor API key  ┌────────────────────────────┐
│ FORGE LLC central server   │ ◄────────────────────── │ Customer local LS sidecar  │
│ (Ed25519 signing key)      │ ──────────────────────► │ (per-customer install)     │
└────────────────────────────┘    signed entitlement   └────────────────────────────┘
                                  bundle (JWS)                       ▲
                                                                     │ HTTPS / LAN
                                                                     │ pull (any auth user)
                                                          ┌──────────┴───────────┐
                                                          │ FORGE app instances  │
                                                          │ (1..N replicas)      │
                                                          └──────────────────────┘
```

## Hop 1 — central ↔ local

The customer's local license server holds two long-lived secrets,
provisioned out-of-band when FORGE LLC creates the customer account:

- `customer_id` — opaque vendor-side identifier (e.g. `CUST-9C3F2A`).
- `activation_key` — high-entropy bearer secret (32 bytes hex,
  rotatable). Sent over TLS as `Authorization: Bearer <key>`.

### `POST /api/v1/activate`

Initial activation. The local LS sends:

```json
{
  "customer_id": "CUST-9C3F2A",
  "instance_id": "ULS-7f3a…",
  "fingerprint": {
    "node_version": "v20.16.0",
    "platform": "linux-x64",
    "hostname_hash": "sha256(hostname)",
    "boot_id": "fb9d1…"
  },
  "client_version": "0.4.0"
}
```

The central server:

1. Authenticates the activation key.
2. Looks up the customer's active license (tier, term, seats, expires_at,
   features).
3. Issues a **signed entitlement bundle** (`entitlement1.<payload>.<sig>`)
   valid for `entitlement_ttl_seconds` (default **24h**).
4. Records the activation in its audit log (`license.activate`).
5. Returns `{ entitlement, refresh_at, expires_at, customer, ... }`.

### `POST /api/v1/refresh`

Periodic refresh. Same auth. Body includes the previously issued
`entitlement` so the central server can reject already-revoked tokens.

Local LS calls this every `refresh_at - 5m`.

### `POST /api/v1/heartbeat`

Lightweight liveness ping. The central server records a `last_seen_at`
on the customer's row and may surface it on the FORGE LLC operator
dashboard. Heartbeats do **not** issue new entitlements.

### Errors

All errors use the same envelope:

```json
{
  "error": "machine_code",
  "message": "Sentence-cased English explanation suitable for end users.",
  "details": { "...": "..." }
}
```

Common machine codes: `auth_invalid`, `customer_disabled`,
`license_not_found`, `license_expired`, `seat_overage_hard_block`,
`rate_limited`, `version_unsupported`.

## Hop 2 — local ↔ FORGE app

The customer's FORGE app instances pull from the local LS over LAN.
This hop never touches the public internet, so it is intentionally
lightweight: a shared secret per LAN, set in both `FORGE_LOCAL_LS_URL`
and `FORGE_LOCAL_LS_TOKEN`.

### `GET /api/v1/entitlement`

Returns the most recently issued bundle plus a sanitised resolved view:

```json
{
  "entitlement": "entitlement1.eyJ…",
  "resolved": {
    "tier": "team",
    "tier_label": "Team",
    "edition_label": "Team edition",
    "term": "annual",
    "term_label": "Annual",
    "seats": 25,
    "features": ["core.auth", "core.docs", "..." ],
    "feature_details": [{ "id": "...", "name": "Documents & revisions", ... }],
    "expires_at": "2027-04-26T00:00:00Z",
    "status": "ok",
    "status_label": "Active",
    "reasons": ["expires_in_29_days"],
    "reason_messages": ["Expires in 29 days."]
  },
  "issued_at": "2026-04-26T14:00:00Z",
  "refresh_at": "2026-04-27T13:55:00Z",
  "grace_until": "2026-05-03T14:00:00Z",
  "online": true,
  "last_central_at": "2026-04-26T14:00:00Z"
}
```

The FORGE app verifies the `entitlement` JWS locally with the bundled
FORGE LLC public key — same primitive as v1 — so a malicious local LS
cannot escalate the customer's tier.

### `GET /api/v1/health`

Operator probe; returns the local LS's view of central connectivity.

## Trust + verification rules

- The Ed25519 signing key lives only on the FORGE LLC central server.
- The matching public key is bundled in every FORGE app and the local
  LS at build time (`config/license-pubkey.pem`).
- The local LS is **untrusted**: the FORGE app independently verifies
  every bundle signature, and refuses bundles where:
  - The signature is invalid.
  - `expires_at` is in the past.
  - `customer_id` does not match the `FORGE_EXPECTED_CUSTOMER_ID`
    when that env var is set (defence against a swapped LS).
- The local LS keeps the **most recent verified** bundle on disk so
  short central-server outages don't take customers down. After
  `grace_until` the local LS still serves the bundle, but flags
  `status = "offline_grace_expired"` so the FORGE app can fail
  paid features closed.

## Why an extra hop?

- One outbound TCP connection per customer, not per FORGE replica
  (matters for HA deployments with 6+ replicas).
- LAN-side auth between FORGE and local LS is simple shared-secret;
  the only public-internet endpoint is the local LS's outbound
  connection to FORGE LLC.
- Local LS can operate behind a corporate proxy, in DMZ, or with
  a static-IP NAT rule, regardless of how many FORGE replicas the
  customer runs.
