# FORGE — Third-party open-source dependencies

FORGE is built on top of a curated set of MIT / Apache 2.0 / BSD / MPL
licensed open-source projects, mapped against the OSS reference list in
`PRODUCT_SPEC.md §16`. All of them are **browser ESM** imports loaded from
`esm.sh` via the import map in `index.html`. The client still runs from
`python3 -m http.server` with no build step; if a CDN is unreachable every
feature degrades to the hand-rolled fallback.

All dependencies are runtime-only (no bundler). Each integration lives
behind a seam (`src/core/vendor.js`) so versions can be pinned per module
or swapped for self-hosted copies without touching call sites.

## Pinned versions

| Package | Version | License | Purpose | Spec clause |
|---|---|---|---|---|
| [pdfjs-dist](https://github.com/mozilla/pdf.js) | 4.6.82 | Apache 2.0 | Native PDF rendering in the doc viewer | §7.10, §11.5 |
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

- **Import map**: declared once in `index.html`. Modules are resolved at
  runtime, no bundler involved.
- **Lazy / dynamic**: heavy modules (`pdfjs-dist`, `web-ifc`, `mermaid`,
  `mqtt`) are loaded on demand via `src/core/vendor.js`, which caches
  promises and, on any import failure, records an `audit` event and
  switches the caller to its hand-rolled fallback.
- **Offline-friendly**: once `esm.sh` has served a module the browser
  caches it. For strict air-gapped deployments, replace the import map
  URLs with a self-hosted `/vendor/` path; nothing else changes.

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
