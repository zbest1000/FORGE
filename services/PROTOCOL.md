# FORGE Licensing — wire protocol

Three components, two protocol hops, **one** online activation per
machine. After activation, FORGE installations run entirely from the
cached, signed token; the only network traffic is a daily heartbeat
from each customer's local LS to FORGE LLC, which is best-effort.

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

## Activation lifecycle

A *seat* is the right to run one FORGE installation against the
customer's license at any given moment. A licence with `seats: N`
allows N concurrent activations.

Each activation goes through these statuses on the central server:

```
                     ┌──────────► released  (voluntary or operator)
                     │
                     │  ┌───────► superseded  (last-writer-wins: another machine took the seat)
                     │  │
   activate  →  active ─┤
                        │
                        └───────► revoked    (operator anti-piracy / fraud)
```

`released` and `superseded` rows can be reused: the next `activate`
call from the same `instance_id` flips the row back to `active` and
issues a new token; an `activate` call from a fresh `instance_id`
either claims an empty slot (status: nothing) or supersedes the
oldest `active` row.

Once `revoked`, an activation is dead until the operator restores it
or the customer is issued a new license entirely.

## Hop 1 — central ↔ local LS

Authentication: long-lived `activation_key` (`fla_…`) the customer's
local LS holds. Stored on the central server as `sha256(key)`.

### `POST /api/v1/activate`

Claim a seat for this `instance_id`. Idempotent: re-activating from
the same instance_id flips the row to `active` and issues a fresh
token. Activating with a new `instance_id` and no free seat
supersedes the oldest activation (last-writer-wins).

Request:

```json
{
  "customer_id": "CUST-9C3F2A",
  "instance_id": "ULS-7f3a…",
  "fingerprint": {
    "node_version": "v20.16.0",
    "platform": "linux-x64",
    "hostname_hash": "sha256(hostname)"
  },
  "client_version": "0.4.0"
}
```

Response (success):

```json
{
  "activation_token": "entitlement1.<payload>.<sig>",
  "activation_id": "ACT-…",
  "activation_token_id": "TOK-…",
  "issued_at": "2026-04-26T14:00:00Z",
  "customer": { "id": "CUST-9C3F2A", "name": "Acme" },
  "license": { "id": "LIC-…", "tier": "enterprise", "term": "annual", "seats": 50,
               "starts_at": "...", "expires_at": "..." },
  "superseded_activation_ids": ["ACT-OTHER", "..."],
  "reused": false
}
```

Errors: `auth_invalid` 401, `auth_revoked` 401, `customer_disabled`
403, `license_not_found` 404, `license_starts_in_future` 409,
`license_expired` 410, `bad_request` 400.

### `POST /api/v1/release`

Voluntary release. Caller proves possession by sending the
`activation_token_id` (or `activation_id` for operator-script use).
Returns `{ ok, activation_id, status: "released", released_at }`.

After a release the seat is free; another machine activating reuses
the slot, and the original machine sees `superseded` on its next
heartbeat. The original machine can also re-activate to take the
seat back (its `instance_id` row will move from `released` to
`active` again).

### `POST /api/v1/heartbeat`

Opportunistic supersession + liveness check. Returns the current
status of the supplied `activation_token_id`. Does NOT issue a new
token.

```json
{
  "active": false,
  "status": "superseded",
  "activation_status": "superseded",
  "superseded_by": "ACT-OTHER",
  "released_at": null,
  "revoked_at": null,
  "last_seen_at": "...",
  "message": "This activation has been replaced by another machine. To take this seat back, run activation again."
}
```

The customer's local LS calls this once a day (configurable via
`LOCAL_LS_HEARTBEAT_S`). FORGE app instances pull the heartbeat
result (alongside the cached token) from the local LS — they do
**not** open a separate connection to the central server.

### Operator endpoints

Authenticated via `OPERATOR_API_TOKEN` (intended to be locked down
by network policy / VPN / IP allowlist).

- `GET  /admin/v1/customers/:id/activations[?status=…]`
- `POST /admin/v1/activations/:id/release`  — operator reclaim, e.g. lost laptop
- `POST /admin/v1/activations/:id/revoke`   — anti-piracy / fraud

Both write to the `audit_log`.

## Hop 2 — local LS ↔ FORGE app

Authentication: shared LAN bearer (`LOCAL_LS_SHARED_TOKEN`, ≥16
chars, timing-safe compare).

### `GET /api/v1/entitlement`

Returns the cached signed activation token plus the current
heartbeat-derived status:

```json
{
  "activation_token": "entitlement1.…",
  "activation_id": "ACT-…",
  "activation_token_id": "TOK-…",
  "issued_at": "2026-04-26T14:00:00Z",
  "activation_status": "active" | "superseded" | "released" | "revoked",
  "superseded_by": "ACT-OTHER",
  "released_at": null,
  "revoked_at": null,
  "last_heartbeat_at": "...",
  "customer": { "id": "...", "name": "..." },
  "license":  { "id": "...", "tier": "...", "term": "...", "seats": ... },
  "instance_id": "ULS-…"
}
```

### `POST /api/v1/release`

Tells the local LS to release this activation against the central
server, then clears the local cache. Used by the FORGE admin UI's
"Release this seat" button.

### `POST /api/v1/activate-now`

Tells the local LS to (re-)activate. Used after a release to take
the seat back, or to recover from operator-initiated reclaim.

### `POST /api/v1/heartbeat-now`

Force a heartbeat right now. The same logic runs automatically
every `LOCAL_LS_HEARTBEAT_S` seconds.

## Trust + verification

- The Ed25519 signing key lives only on the FORGE LLC central server
  (set via `FORGE_LICENSE_SIGNING_KEY[_PATH]`).
- The matching public key is bundled into every FORGE app and every
  local LS at build time (`config/license-pubkey.pem`), or can be
  overridden at runtime via `FORGE_LICENSE_PUBLIC_KEY`.
- The local LS is **untrusted**: the FORGE app independently verifies
  every activation token signature, refuses tokens whose `bound_fingerprint`
  doesn't match the host (unless `FORGE_SKIP_FINGERPRINT=1`), and
  refuses tokens whose `issued_at` is in the future (clock-back
  tampering defence).
- `FORGE_EXPECTED_CUSTOMER_ID` adds defence against a swapped local
  LS: the FORGE app refuses any token whose `customer_id` doesn't
  match.

## Why no rotation expiry on the activation token?

The activation token has no rotation expiry of its own. Validity is
governed by:

1. **Signature** — verified on every read by the FORGE app.
2. **Wall clock** — must not be earlier than `issued_at`, must not
   be later than `license_expires_at` (annual licenses).
3. **Heartbeat status** — `superseded` / `released` / `revoked` from
   the local LS's last successful contact with the central server
   downgrades the FORGE app to the Community plan immediately.
4. **Bound fingerprint** — the activation is bound to the host that
   originally activated; tokens carried to a different host are
   refused.

Why this design over short-lived rotating bundles:

- **No periodic internet need.** Once activated, an air-gap-tolerant
  FORGE installation runs indefinitely. The local LS only needs to
  reach FORGE LLC during initial activation, when the customer
  voluntarily releases the seat, and during the daily heartbeat
  (best-effort).
- **Datetime sanity is enough** because the license `expires_at`
  doesn't move and clock-back tampering is detectable from the token
  payload alone.
- **Last-writer-wins** is the model customers actually want for
  workstation licenses ("I'm moving my license to my new laptop").
  Short-lived bundles would either need a separate seat-allocator
  service or would risk cross-machine token sharing.
