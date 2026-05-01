# FORGE

**Federated Operations, Research, Governance, and Engineering** — a secure, self-hostable engineering collaboration and execution platform. One product covering team chat, work management, document + drawing control, asset and incident operations, MQTT / OPC UA / SQL connectors, and an in-process Unified Namespace (CESMII i3X 1.0-Beta) — all licensed for self-hosting on a single VM, a Kubernetes cluster, or as a container image.

## Run

FORGE ships as a **server + client** and also runs client-only in "demo mode" for quick UX inspection.

### Server (recommended)

```bash
npm install
npm run build       # production SPA bundle in ./dist
npm run seed        # one-time: creates ./data/forge.db + demo users
npm start           # Fastify on http://localhost:3000
# admin@forge.local / forge
```

For local source-module development use `npm run dev` (sets `FORGE_SERVE_SOURCE=1`) or `npm run dev:client`. Production must ship `dist/`. A `Dockerfile` and `docker-compose.yml` (with an optional Mosquitto broker) are included; the release pipeline publishes a multi-arch container image to GHCR signed with cosign keyless and a CycloneDX SBOM.

See [`docs/INSTALL.md`](docs/INSTALL.md) for the full install + bootstrap walkthrough, and [`docs/SERVER.md`](docs/SERVER.md) for the API surface, deployment, and security model.

### Client-only demo (no backend)

```bash
python3 -m http.server 8080
# open http://localhost:8080
```

The client probes `/api/health` on boot and falls back to a fully-offline demo when no backend responds.

## Documentation map

The product spec is the source of truth; everything else is operational or architectural detail that supports it.

| Topic | Doc |
|---|---|
| What FORGE is | [`PRODUCT_SPEC.md`](PRODUCT_SPEC.md) |
| Documentation index | [`docs/README.md`](docs/README.md) |
| Engineering policy | [`docs/ENGINEERING_PHILOSOPHY.md`](docs/ENGINEERING_PHILOSOPHY.md) — the "don't rebuild the wheel" rule + per-concern OSS register |
| Architecture | [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) |
| Industrial-edge spec | [`docs/INDUSTRIAL_EDGE_PLATFORM_SPEC.md`](docs/INDUSTRIAL_EDGE_PLATFORM_SPEC.md) |
| UX plan + design rationale | [`docs/UX_AUDIT.md`](docs/UX_AUDIT.md) |
| Spec compliance matrix | [`docs/SPEC_COMPLIANCE.md`](docs/SPEC_COMPLIANCE.md) |
| Security policy | [`SECURITY.md`](SECURITY.md), [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md) |
| Operations | [`docs/INSTALL.md`](docs/INSTALL.md), [`docs/SERVER.md`](docs/SERVER.md), [`docs/RELEASE.md`](docs/RELEASE.md), [`docs/INCIDENT_RUNBOOK.md`](docs/INCIDENT_RUNBOOK.md), [`docs/SLO.md`](docs/SLO.md) |
| Contributing | [`CONTRIBUTING.md`](CONTRIBUTING.md) |
| CI workflows | [`.github/workflows/README.md`](.github/workflows/README.md) |

## Engineering philosophy

> Don't rebuild the wheel.

Every concern is solved by a mature permissive-licensed open-source project first; hand-rolled code only when no fit exists or the surface needs redesigning around the spec. The full decision matrix, per-concern OSS register, and pre-flight checklist live in [`docs/ENGINEERING_PHILOSOPHY.md`](docs/ENGINEERING_PHILOSOPHY.md). Every PR is expected to walk it.

## What's in this repository

```
├─ index.html              # Vite entry + shell mount points
├─ styles.css              # design tokens (motion / spacing / shadow / theme),
│                          #   utility classes, component styles, print sheet
├─ app.js                  # module bootstrap + route registry + theme resolver
├─ server/                 # Fastify backend
│   ├─ main.js             # boot — JWT, CORS, rate-limit, multipart, routes
│   ├─ db.js               # SQLite schema + migrations (currently v17)
│   ├─ routes/             # REST surface — REST + GraphQL + SSE
│   ├─ connectors/         # MQTT / OPC UA / SQL registry + Sparkplug B codec
│   ├─ historians/         # mssql / postgres / mysql / sqlite adapters
│   ├─ security/           # SQL validator, outbound-URL guard, secrets
│   ├─ services/           # image transcode, etc.
│   └─ integrations/       # external system registry + ERP/CMMS adapters
├─ src/
│   ├─ core/               # store, router, permissions, UI primitives,
│   │                      #   command palette, theme, breadcrumb, idle scheduler,
│   │                      #   audit, search, FSM library
│   │   └─ i3x/            # in-process CESMII i3X 1.0-Beta engine
│   ├─ shell/              # rail / left panel / header / context panel / dock
│   ├─ screens/            # 31 functional screens (see below)
│   └─ data/               # in-browser seed for demo mode
├─ test/                   # node:test integration + unit tests
├─ docs/                   # operational + architectural docs (see docs/README.md)
└─ .github/workflows/      # CI, release, security scans (see .github/workflows/README.md)
```

### Screens

Workspace home, Inbox, Search, Hub launcher, Team Spaces, Channels, Work Board (Kanban + table + timeline + calendar + batch), Document Viewer (with revision-compare), Drawing Viewer (SVG + DXF + IFC), Asset Dashboard (cards + per-asset detail with Live + Historical chart toggle), Asset Configuration, Asset Data, Asset Detail, Profiles Admin, Incident War Room, Approvals, Integrations Console (MQTT / OPC UA / ERP), Operations Data, AI Workspace, Admin Governance, Audit Ledger, Dashboards, Unified Namespace browser, i3X API Workbench, Spec reference. Full feature breakdown in [`PRODUCT_SPEC.md`](PRODUCT_SPEC.md).

## Implemented platform features

- **Shell** — workspace switcher rail, left panel with grouped trees, header with command palette + portal scoping, on-demand right context panel, operations dock with live status chips. Layout toggles for hide-rail / hide-left / hide-right / hide-header / focus mode / field mode (touch-first). Responsive down to 640 px (rail repositions to a sticky bottom bar).
- **Command palette** — `⌘K` / `Ctrl+K` jumps to any object or screen; supports `/go OBJ-ID` direct navigation.
- **Persistent state** — all mutations persist to `localStorage`; theme resolution honours `prefers-color-scheme` on first paint via an inline pre-paint script.
- **Audit log** — every create / update / transition / approval / markup / incident change is appended to a hash-chained ledger; signed audit-pack export with HMAC-SHA256.
- **Permissions** — role-based RBAC with capability gates (`view`, `create`, `edit`, `approve`, `incident.command`, `integration.read/write`, `device.write`, `historian.sql.raw`, `webhook.write`, `admin.view/edit`); ACLs per object; group + portal scoping.
- **Connectors** — MQTT (3.1.1 + 5.0, raw JSON or Sparkplug B encoding), OPC UA (Historical Read against any FORGE-backed historian, address-space refresh on writes, value writeback as a method call), SQL polling (mssql / postgres / mysql / sqlite, schema-defined or free-form gated by `historian.sql.raw`), in-process MQTT broker for southbound ingest, Modbus TCP. All connectors share the orchestrator + dead-letter queue.
- **Asset Dashboard** — ISA-95 hierarchy (Enterprise → Site → Area → Line/Cell → Asset), Profiles + per-asset bindings (versioned, immutable history), live SSE telemetry, image-upload pipeline that transcodes HEIC / AVIF to WebP + JPEG via libvips.
- **Unified Namespace** — every asset emitted to a canonical UNS path with alternate addresses (MQTT topic, OPC UA nodeId, FORGE id) for cross-resolution. Implements the CESMII i3X 1.0-Beta OpenAPI surface in-process.
- **AI** — threaded assistant with scope-aware prompts, citations, doc-Q&A, daily engineering brief.
- **Compliance** — tenant scoping (org_id) on every write, refresh-token sessions with revocation, MFA (TOTP + recovery codes), webhook SSRF guard, idempotency-key contract, WCAG 2.1 AA contrast across both themes (CI-enforced), `prefers-reduced-motion` respect, forced-colors mode, print stylesheet.

## Development

```bash
npm install
npm run seed       # one-time: ./data/forge.db
npm run dev        # node --watch server/main.js (dev shell)
npm test           # node --test (full suite — currently 419 pass / 3 skipped)
npm run typecheck  # tsc --noEmit
npm run build      # production SPA bundle to ./dist
npm run release:check   # build + tests + smoke against the built server
```

CI is the gate — see [`.github/workflows/README.md`](.github/workflows/README.md). Branch protection requires `CI success` + `CodeQL` + `Gitleaks` + `Trivy vulnerability scan` (when paths trigger the container scan).

Console helper: `window.__forgeSelfTest()` asserts seed integrity from the browser devtools.

## License

See [`LICENSE`](LICENSE) and [`docs/LICENSING.md`](docs/LICENSING.md).
