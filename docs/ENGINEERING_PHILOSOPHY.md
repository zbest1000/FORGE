# FORGE — Engineering Philosophy

> **Don't rebuild the wheel. Reuse a built one and improve it (or redesign
> the surface around it) only when the spec genuinely demands something
> the OSS doesn't.**

This document is a permanent contract for everyone (humans **and** AI
agents) working on this repository. Every PR — including auto-generated
ones — must read it, follow the decision matrix, and update it when a
new concern surfaces.

---

## 1. Why this rule

FORGE's spec is broad: collaboration + work execution + engineering
records + drawing/model review + asset/data context + AI + governance.
Each of those domains has decades of mature open-source already. A
prototype that hand-rolls every primitive ends up shallow on every
surface and can't ship. A prototype that **assembles** the right OSS
gets to depth fast and stays maintainable because someone else owns the
heavy lifting.

The cost of a small dependency is not the install size — it's:

- **review burden** (license, supply chain, governance);
- **lock-in** (can we replace it later?);
- **integration debt** (does its model match ours?).

These costs are real but **smaller than the cost of maintaining a
half-built reimplementation in perpetuity**. Default to OSS; only
reimplement when the math comes out the other way and **document the
reason** in `docs/AUDIT_LOG.md`.

---

## 2. Decision matrix (use this before writing new code)

For every new concern, walk the matrix top to bottom. Stop at the first
green check.

| Question | If yes → |
|---|---|
| Is there an industry-standard OSS that solves >80 % of this concern, has >1 maintainer, and a permissive or weak-copyleft license? | **Use it.** Wrap it behind a thin seam (single import, single function call) so it's swappable. |
| Is there an OSS that solves the concern but with one or two missing features we need? | **Use it + extend it.** Either upstream the patch (preferred) or write a thin adapter; never fork wholesale unless the project is unmaintained. |
| Is there an OSS that solves the concern but the model is wrong for our domain? | **Use it as the engine, redesign the surface.** Example: we use SQLite via `better-sqlite3`, but the FORGE object model lives in our own schema on top. |
| Is the concern small (≤ ~80 LoC), the OSS unfit (heavy, abandoned, GPL when we can't accept it, or wrong runtime), and the implementation easy to test? | **Hand-roll, with a TODO link to the OSS we'd swap to later.** Keep it isolated behind an interface. |
| None of the above | **Reconsider the requirement.** Talk to the spec owner before writing code. |

The matrix is **not advisory**. It's the order of operations.

---

## 3. License rules

- Always permissive or weak-copyleft for **runtime** dependencies (MIT,
  Apache-2.0, BSD, MPL-2.0, ISC, Unlicense).
- AGPL/GPL allowed only for **services we deploy** behind FORGE
  (e.g. n8n's Sustainable Use License, AGPL Mattermost server) where
  the linkage is over the network and our code is not derived.
- LGPL allowed only for shared libraries dynamically linked.
- Any **source-available** but non-OSI license (Sustainable Use,
  Business Source, Elastic, SSPL) must be flagged in
  `docs/THIRD_PARTY.md` with a one-line justification.
- **No GPL-licensed npm dependency in `dependencies` or `peerDependencies`.**

---

## 4. Security and supply-chain hygiene

Even when an OSS package is the right answer, the dependency must:

1. Be pinned to an exact (or `^`/`~`) version range in `package.json`.
2. Have its license recorded in `docs/THIRD_PARTY.md`.
3. Be reachable through a **single seam** in the codebase (one import
   site, one wrapper module) so we can swap it out without surgery.
4. Have a non-fatal **fallback** when the dependency is unavailable
   (e.g. if a CDN is blocked, the client should still degrade
   gracefully — see how `src/core/vendor.js` calls hand-rolled fallbacks
   on import failure).
5. Be checked against `npm audit` / Snyk on CI before merge.

When an upstream is **abandoned**, **insecure**, or **license-changes**,
the swap-out PR must:

- Update `docs/THIRD_PARTY.md` with the deprecation reason.
- Reference the migration in `docs/AUDIT_LOG.md` with the same
  what / why / tech / files / verification template.

---

## 5. The "swap-point" pattern

Every non-trivial third-party integration in FORGE goes behind a small
adapter, so the rest of the codebase doesn't import the OSS directly.
Examples already in place:

| Concern | OSS | Single seam |
|---|---|---|
| Search index (server) | SQLite FTS5 | `server/routes/core.js` `/api/search` + `server/graphql/resolvers.js` `searchHits()` |
| Search index (client) | MiniSearch | `src/core/search.js` |
| Markdown rendering | marked + DOMPurify | `src/core/md.js` |
| Drawing zoom/pan | svg-pan-zoom | `src/screens/drawingViewer.js` |
| Charts | µPlot | `src/core/charts.js` |
| MQTT bridge | MQTT.js | `server/connectors/mqtt.js` |
| OPC UA bridge | node-opcua | `server/connectors/opcua.js` |
| Workflow automation | n8n | `server/connectors/n8n.js` + `server/routes/automations.js` |
| GraphQL | Mercurius | `server/main.js` registration block |
| Diagrams | Mermaid | `src/core/mermaid.js` |
| Fuzzy palette | Fuse.js | `src/core/palette.js` |
| Crypto | Web Crypto / Node `node:crypto` | `src/core/crypto.js`, `server/crypto.js` |
| AI providers | OpenAI HTTP / Ollama HTTP / local fallback | `server/ai.js` |

If you find yourself importing a package directly from more than one
file, **extract a wrapper module**. The seam is what lets us swap or
upgrade the dep later without touching call sites.

---

## 6. Per-concern OSS register

Use this as the authoritative pre-flight checklist. If you're about to
write code that touches any concern below, **start from the OSS column**.

### Web infrastructure
| Concern | Default OSS | Adapter location | Status |
|---|---|---|---|
| HTTP server | **Fastify** | `server/main.js` | ✅ in use |
| GraphQL | **Mercurius** | `server/graphql/*` | ✅ in use |
| Auth (JWT) | **@fastify/jwt** | `server/main.js`, `server/auth.js` | ✅ in use |
| OIDC SSO | `@fastify/oauth2` | TBD when SSO lands | planned |
| SCIM | `scim-patch` + custom controller | TBD | planned |
| Multipart uploads | **@fastify/multipart** | `server/routes/files.js` | ✅ in use |
| Static serving | **@fastify/static** | `server/main.js` | ✅ in use |
| CORS | **@fastify/cors** | `server/main.js` | ✅ in use |
| Secure headers | **@fastify/helmet** | `server/main.js` | ✅ in use |
| Rate limit | **@fastify/rate-limit** | `server/main.js` | ✅ in use |
| Structured logs | **pino** | Fastify built-in | ✅ in use |
| Prometheus metrics | **prom-client** | `server/metrics.js` | ✅ in use (was hand-rolled, swapped) |
| OpenAPI / spec serve | `@fastify/swagger` | TBD if we expose Swagger UI | candidate |
| WebSockets | `@fastify/websocket` | TBD | candidate |

### Persistence
| Concern | Default OSS | Adapter location | Status |
|---|---|---|---|
| Embedded SQL | **better-sqlite3** | `server/db.js` | ✅ in use |
| Postgres adapter | **pg** | TBD when scale demands | candidate |
| Search FTS | SQLite FTS5 (server) / **MiniSearch** (client) | `core.js`, `core/search.js` | ✅ in use |
| Vector embeddings | **sqlite-vss** or **pgvector** + `@xenova/transformers` | TBD when semantic stage upgrades | candidate |
| Migrations | hand-rolled `db.js` `migrate()` | `server/db.js` | acceptable; swap to `umzug` if it grows |

### Crypto / security
| Concern | Default OSS | Adapter location | Status |
|---|---|---|---|
| Hashing | **Web Crypto** (SHA-256) | `crypto.js` (both sides) | ✅ in use |
| HMAC signing | **Web Crypto** (HMAC-SHA256) | `crypto.js` | ✅ in use |
| Password hashing | **bcryptjs** | `server/auth.js` | ✅ in use |
| TOTP / WebAuthn | **otpauth** + **@simplewebauthn/server** | TBD MFA | candidate |
| KMS / Vault | **HashiCorp Vault** Node SDK | `server/crypto.js` `getKey()` | candidate |

### Background work / events
| Concern | Default OSS | Adapter location | Status |
|---|---|---|---|
| Workflow automation | **n8n** | `server/connectors/n8n.js` | ✅ in use |
| Job queue (Node) | **BullMQ** + Redis | when in-process workers outgrow the server | candidate |
| MQTT broker | **EMQX** / **Mosquitto** | docker-compose service | ✅ Mosquitto in use |
| MQTT client | **MQTT.js** | `connectors/mqtt.js` | ✅ in use |
| OPC UA | **node-opcua** | `connectors/opcua.js` | ✅ in use |

### UI / browser
| Concern | Default OSS | Adapter location | Status |
|---|---|---|---|
| PDF viewer | **PDF.js** | `src/core/pdf.js` | ✅ in use |
| Markdown | **marked** + **DOMPurify** | `src/core/md.js` | ✅ in use |
| CSV / spreadsheet | **PapaParse** (client) | `src/core/csv.js` | ✅ in use (was hand-rolled, swapped) |
| BIM / IFC | **web-ifc** + **web-ifc-viewer** for 3D | `drawingViewer.js` IFC tab | ◐ decoder in use; viewer pending |
| SVG zoom/pan | **svg-pan-zoom** | `drawingViewer.js` | ✅ in use |
| Diagrams | **Mermaid** | `src/core/mermaid.js` | ✅ in use |
| Charts | **µPlot** | `src/core/charts.js` | ✅ in use |
| Search (client) | **MiniSearch** + **Fuse.js** for palette | `core/search.js`, `core/palette.js` | ✅ in use |
| OpenAPI explorer | **RapiDoc** | `screens/i3x.js` | ✅ in use |
| Service worker | **Workbox** | `sw.js` | ✅ in use (was hand-rolled, swapped) |
| Date / time | **date-fns** | `src/core/time.js` | ✅ in use |
| Icons | **lucide** (SVG) | TBD if we replace emoji icons | candidate |

### AI / NLP
| Concern | Default OSS | Adapter location | Status |
|---|---|---|---|
| LLM provider gateway | own router | `server/ai.js` | ✅ in use |
| Local LLM | **Ollama** | adapter | ✅ in use |
| OpenAI-compatible | own HTTP adapter | adapter | ✅ in use |
| Embeddings | **@xenova/transformers** for in-process; or hosted | TBD | candidate |

### State machines / lifecycles
| Concern | Default OSS | Adapter location | Status |
|---|---|---|---|
| Revision lifecycle (Draft→IFR→Approved→IFC→Superseded/Archived/Rejected) | **xstate v5** | `src/core/fsm/revision.js` | ✅ in use |
| Approval lifecycle (pending→approved/rejected/expired/delegated) | **xstate v5** | `src/core/fsm/approval.js` | ✅ in use |
| Incident lifecycle (active→escalated→stabilized→resolved→postmortem) | **xstate v5** | `src/core/fsm/incident.js` | ✅ in use |

### CAD / engineering documents
| Concern | Default OSS | License | Adapter location | Status |
|---|---|---|---|---|
| PDF | **PDF.js** | Apache-2.0 | `src/core/pdf.js` | ✅ |
| DXF (AutoCAD interchange, 2D) | **dxf-viewer** | MIT | `src/core/cad-viewer.js` | ✅ |
| DWG (AutoCAD native, 2D) | **LibreDWG** `dwg2dxf` (subprocess) | GPL-3.0 (deployed-service exception) | `server/converters/dwg.js` + `server/routes/cad.js` → output served via dxf-viewer | ✅ |
| STEP / IGES / STL / OBJ / glTF / 3DM / 3DS / 3MF / FBX / DAE / PLY / BREP / OFF / VRML | **Online3DViewer** (wraps three.js + occt-import-js) | MIT | `src/core/cad-viewer.js` (lazy-load) | ✅ |
| IFC / BIM | **web-ifc** + Online3DViewer | MPL-2.0 / MIT | drawing viewer IFC tab + `cad-viewer.js` | ✅ |
| 3D engine | **three.js** | MIT | shared dep of DXF + Online3DViewer | ✅ |
| Image (PNG / JPG / SVG) | native `<img>` | — | doc viewer | ✅ |
| Spreadsheet (CSV) | **PapaParse** | MIT | `src/core/csv.js` | ✅ |
| Spreadsheet (XLSX) | **SheetJS Community** | Apache-2.0 | TBD when needed | candidate |

### Spec §16 reference projects (already aligned)
- Mattermost — collaboration patterns
- Keycloak — SSO/SCIM
- open62541 / Eclipse Milo — OPC UA
- EMQX — MQTT broker
- Apache PLC4X — protocol expansion (Java; out of scope client-side)
- OpenSearch — search at scale
- PDF.js — PDF rendering

---

## 7. Pre-implementation checklist

When you're about to write a new feature, copy this checklist into the
PR description and fill it in:

- [ ] What spec clause does this implement?
- [ ] Which row of the OSS register applies?
- [ ] If no row applies, did I search npm / GitHub for prior art?
      Result: _link or N/A_.
- [ ] Did I file the dep in `docs/THIRD_PARTY.md`?
- [ ] Did I add the seam (single import site / wrapper module)?
- [ ] Did I add a non-fatal fallback if the dep is unavailable?
- [ ] Did I update `docs/AUDIT_LOG.md`?
- [ ] Did I update `docs/SPEC_COMPLIANCE.md`?
- [ ] Are tests in `test/` exercising the new path?

---

## 8. When to redesign instead of reuse

The matrix says "redesign the surface" when the OSS engine is right but
the model is wrong. Three real examples in this codebase:

1. **Audit ledger.** No off-the-shelf hash-chained audit DB ships with
   exactly the FORGE shape (per-tenant, per-actor, per-object,
   tamper-evident). We use **Web Crypto** for hashing and SQLite for
   storage but designed our own append + verify surface in
   `server/audit.js`. Swap-point: replace `getKey()` with a KMS call.

2. **i3X engine.** The CESMII spec is the contract; no OSS
   implementation matched yet, so we wrote a small in-process engine
   (`src/core/i3x/server.js`) and **share it** between client (demo
   mode) and server. The seam is the engine module itself; a real
   external server can be addressed by replacing the `client.js`
   wrapper with a `fetch()` call.

3. **Revision / approval / incident state machines.** Originally
   hand-rolled — and the doc said "xstate would be overkill for ~10
   transitions". That was wrong: by the time the spec gap-closing
   work landed, the same rules were typed by hand in 4 places
   (client core, REST route, GraphQL resolver, approval cascade) and
   were starting to drift (e.g. the GraphQL resolver had a slightly
   different ALLOWED table). Reversing the call: **xstate v5** is now
   the source of truth in `src/core/fsm/{revision,approval,incident}.js`,
   imported on both client and server. The lesson — **walk the matrix
   again whenever a hand-rolled rule appears in more than two files**.

These are documented in `AUDIT_LOG.md`; do the same when you redesign.

### Lesson — re-walk the matrix as the codebase grows

A "small" rule that lives in one file can outgrow that envelope without
warning. When you see the same logic copy-pasted in a third place,
treat it as a signal to re-walk the decision matrix from §2 with the
**actual** scope, not the original one. The xstate reversal above is
the canonical example.

---

## 9. Updating this document

When you add a new concern that doesn't fit the register:
1. Add a row to the right table.
2. State the chosen OSS with its license.
3. Reference the seam in code.
4. Append a one-line entry under "Updates" below.

## Updates

- **2026-04-25** — Created. Codifies the rule, the matrix, and the OSS
  register. Three wheels swapped to canonical OSS in the same PR
  (Prometheus → `prom-client`, service worker → Workbox, CSV parser →
  PapaParse). See `docs/AUDIT_LOG.md` 2026-04-25 entry for details.
- **2026-04-25** — Reversed the earlier "xstate is overkill" call.
  Three FSMs (revision / approval / incident) had been duplicated
  across 9 sites. **xstate v5** is now the single source of truth in
  `src/core/fsm/`, imported on client and server. Added the §8
  re-walk-the-matrix lesson. See `docs/AUDIT_LOG.md` for the full
  refactor entry.
- **2026-04-25** — CAD support: DXF via dxf-viewer (MIT), DWG via
  LibreDWG `dwg2dxf` (GPL-3.0, deployed-service exception), and
  STEP/IGES/STL/OBJ/glTF/3DM/3DS/3MF/FBX/DAE/PLY/BREP/OFF/VRML via
  Online3DViewer (MIT, three.js + occt-import-js). Single seam:
  `src/core/cad-viewer.js`. Server-side conversion route at
  `/api/cad/convert/:fileId` with SHA-256 caching.
