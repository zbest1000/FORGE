# FORGE — Third-party open-source dependencies

FORGE is built on top of a curated set of MIT / Apache 2.0 / BSD / MPL
licensed open-source projects, mapped against the OSS reference list in
`PRODUCT_SPEC.md §16`. Enterprise builds bundle browser dependencies with
Vite into `dist/`. The `index.html` import map remains only as a local
source-serving fallback for `FORGE_SERVE_SOURCE=1` development.

Each integration lives behind a seam (`src/core/vendor.js`) so versions can be
pinned through npm and swapped without touching call sites.

## Pinned versions

### Server-side (Node, npm)

| Package | License | Purpose | Spec clause |
|---|---|---|---|
| [fastify](https://github.com/fastify/fastify) | MIT | HTTP server | §1.1 |
| [@fastify/jwt](https://github.com/fastify/fastify-jwt) | MIT | Bearer-token auth | §13.1 |
| [@fastify/helmet](https://github.com/fastify/fastify-helmet) | MIT | Secure headers | §13 |
| [@fastify/rate-limit](https://github.com/fastify/fastify-rate-limit) | MIT | Per-user/IP throttle | §13 |
| [@fastify/multipart](https://github.com/fastify/fastify-multipart) | MIT | File uploads | §7 #10 |
| [@fastify/static](https://github.com/fastify/fastify-static) | MIT | SPA static serving | §11 |
| [@fastify/cors](https://github.com/fastify/fastify-cors) | MIT | CORS policy | §13 |
| [bcryptjs](https://github.com/dcodeIO/bcrypt.js) | MIT | Password hashing | §13.1 |
| [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) | MIT | SQLite + WAL + FTS5 | §1.1, §15 |
| [mqtt](https://github.com/mqttjs/MQTT.js) | MIT | MQTT bridge | §6.4, §9.1 |
| [pino](https://github.com/pinojs/pino) | MIT | Structured logs | §18 |
| [mercurius](https://github.com/mercurius-js/mercurius) | MIT | GraphQL over Fastify | §15 traversal, n8n integration |
| [graphql](https://github.com/graphql/graphql-js) | MIT | Reference GraphQL runtime | §15 |
| [prom-client](https://github.com/siimon/prom-client) | Apache-2.0 | Prometheus metrics + Node process metrics | §18 |
| [xstate](https://github.com/statelyai/xstate) | MIT | Revision / approval / incident lifecycle state machines (one source of truth across client + REST + GraphQL) | §6.3, §11.13, §11.14 |
| node-opcua *(optional)* | MIT | OPC UA ingress | §6.4, §9.1 |

### Self-hosted services (docker-compose)

| Image | License | Purpose |
|---|---|---|
| [n8nio/n8n](https://github.com/n8n-io/n8n) | **Sustainable Use License** (source-available; free for internal/business use) | Workflow automation engine — 400+ pre-built connectors covering spec §6.2 "Automation rules from integration events" |
| [eclipse-mosquitto](https://github.com/eclipse/mosquitto) | EPL-2.0 / EDL-1.0 | MQTT broker dev sibling |
| [LibreDWG](https://www.gnu.org/software/libredwg/) (`libredwg-tools`) | **GPL-3.0** (deployed-service exception — runs as a subprocess; FORGE code is not derived) | `dwg2dxf` CLI used by `server/converters/dwg.js` to convert DWG → DXF on the server |

### Client-side (browser, bundled by Vite)

| Package | Version | License | Purpose | Spec clause |
|---|---|---|---|---|
| [pdfjs-dist](https://github.com/mozilla/pdf.js) | 4.6.82 | Apache 2.0 | Native PDF rendering in the doc viewer | §7.10, §11.5 |
| [papaparse](https://github.com/mholt/PapaParse) | 5.4.1 | MIT | CSV parsing in the doc viewer (de-facto browser CSV) | §7.10 |
| [workbox-sw](https://github.com/GoogleChrome/workbox) | 7.1.0 | MIT | Service worker routing + BackgroundSync queue (offline drafts) | §12.5 |
| [xstate](https://github.com/statelyai/xstate) | 5.30.0 | MIT | FSMs for revision / approval / incident lifecycles (loaded via import map for client) | §6.3, §11.13, §11.14 |
| [three](https://github.com/mrdoob/three.js) | 0.169.0 | MIT | 3D engine shared by dxf-viewer + Online3DViewer | §8 |
| [dxf-viewer](https://github.com/vagran/dxf-viewer) | 1.1.7 | MIT | DXF rendering (and the destination format for converted DWG) | §6.3, §8 |
| [online-3d-viewer](https://github.com/kovacsv/Online3DViewer) | 0.16.0 | MIT | STEP / IGES / STL / OBJ / glTF / 3DM / 3DS / 3MF / FBX / DAE / PLY / BREP / OFF / VRML / IFC viewer (wraps three.js + occt-import-js) | §6.3, §7.11, §8 |
| [minisearch](https://github.com/lucaong/minisearch) | 7.1.2 | MIT | BM25 + prefix + fuzzy full-text search | §15 |
| [dexie](https://github.com/dexie/Dexie.js) | 4.0.11 | Apache 2.0 | IndexedDB append-only logs (audit, events, DLQ) | §13.2, §9.4 |
| [marked](https://github.com/markedjs/marked) | 14.1.3 | MIT | Markdown rendering in channel messages, transmittals, doc viewer | §6.1, §7 |
| [dompurify](https://github.com/cure53/DOMPurify) | 3.1.7 | MPL 2.0 | XSS-safe HTML sanitization after markdown | cross-cutting |
| [mermaid](https://github.com/mermaid-js/mermaid) | 11.4.1 | MIT | Dependency maps, incident flowcharts, impact graphs | §11.4, §11.13, §6.5 |
| [svg-pan-zoom](https://github.com/bumbu/svg-pan-zoom) | 3.6.2 | BSD-2 | Drawing viewer zoom/pan/fit | §8 |
| [uplot](https://github.com/leeoniya/uPlot) | 1.6.31 | MIT | Telemetry sparklines, UNS live charts, dashboards | §6.4, §11.8, §11.1 |
| [mqtt](https://github.com/mqttjs/MQTT.js) | 5.10.1 | MIT | Live MQTT broker connect over WebSockets | §6.4, §9.1, §10 #4 |
| [web-ifc](https://github.com/ThatOpen/engine_web-ifc) | 0.0.66 | MPL 2.0 | IFC/BIM geometry decoding in drawing viewer IFC mode | §8 BIM, §7.11 |
| [fuse.js](https://github.com/krisk/fuse) | 7.0.0 | Apache 2.0 | Fuzzy matching in the command palette | §5.3 |
| [date-fns](https://github.com/date-fns/date-fns) | 4.1.0 | MIT | Human-readable time formatting (SLA, timelines) | §11.1, §11.13, §11.14 |
| [rapidoc](https://github.com/rapi-doc/RapiDoc) | 9.3.8 | MIT | Interactive OpenAPI explorer for the i3X API | §9, i3X support |

## Reference-only OSS (architectural alignment; not bundled)

These projects in spec §16 are server-side or runtime components we would
deploy behind FORGE, not inside the browser. They are listed here so it's
clear which parts of the stack they cover.

| Project | License | Role |
|---|---|---|
| [Mattermost](https://github.com/mattermost/mattermost) | AGPL/MIT | Collaboration mechanics reference (channels, threads). FORGE's UI mirrors the patterns but runs standalone. |
| [Keycloak](https://github.com/keycloak/keycloak) | Apache 2.0 | Identity / SSO (SAML, OIDC) / SCIM target for a production deployment. Surfaced in Admin console config. |
| [EMQX](https://github.com/emqx/emqx) | Apache 2.0 / BSL | Reference MQTT broker. MQTT.js in the browser connects to any MQTT 3.1.1/5 broker (EMQX, HiveMQ, Mosquitto). |
| [open62541](https://github.com/open62541/open62541) / [Eclipse Milo](https://github.com/eclipse/milo) | MPL 2.0 / EPL | OPC UA server reference for the back-end gateway FORGE would talk to. |
| [Apache PLC4X](https://github.com/apache/plc4x) | Apache 2.0 | Industrial-protocol expansion reference (Siemens S7, Modbus, etc.). |
| [OpenSearch](https://github.com/opensearch-project/OpenSearch) | Apache 2.0 | Server-side search reference. MiniSearch is used in-browser as the spec §15 hybrid retrieval front-end. |

## Loading strategy

- **Build-first**: `npm run build` bundles browser dependencies into hashed
  assets under `dist/`.
- **Lazy / dynamic**: heavy modules (`pdfjs-dist`, `web-ifc`, `mermaid`,
  `mqtt`) are loaded on demand via `src/core/vendor.js`, which caches promises
  and lets callers fall back to hand-rolled behavior when a feature module is
  unavailable.
- **Source fallback**: the import map in `index.html` exists only for explicit
  source-module development (`FORGE_SERVE_SOURCE=1`), not for release builds.

## License compatibility

All runtime dependencies are under permissive or weak-copyleft licenses
(MIT, Apache 2.0, BSD-2, MPL 2.0). No GPL dependency is bundled. This
keeps FORGE redistributable under the repository's top-level license.

## Why not more OSS?

The screens themselves (kanban, approvals, incident room, admin console)
are intentionally hand-rolled: there is no OSS package that matches the
spec's UX anatomy closely enough to be worth integrating. Component
kernels like data tables or modals would pull in design-system dependencies
far heavier than the ~200 lines of `src/core/ui.js`.
