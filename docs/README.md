# FORGE documentation index

The product spec lives at the repo root ([`PRODUCT_SPEC.md`](../PRODUCT_SPEC.md)). Everything in this directory is operational, architectural, or compliance-facing detail that supports it. Read this index first to find the canonical doc for whatever you're working on — every other file in the repo points back here.

## By topic

### Build, run, ship

| Doc | Purpose |
|---|---|
| [`INSTALL.md`](INSTALL.md) | Install + bootstrap walkthrough for the self-hosted server (Linux, macOS, Windows, Docker). |
| [`SERVER.md`](SERVER.md) | Full server reference — boot flow, env vars, REST surface, deployment, security model. |
| [`RELEASE.md`](RELEASE.md) | Tag-driven release flow + how the GitHub-Actions release pipeline composes archives, SBOM, and the signed container. |
| [`SCHEMA_UPGRADE.md`](SCHEMA_UPGRADE.md) | SQLite schema migration policy + every version bump's changes. |
| [`OFFICE_VIEWERS.md`](OFFICE_VIEWERS.md) | Office-document viewer setup (Univer integration). |

### Architecture + spec

| Doc | Purpose |
|---|---|
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | Top-down architectural overview — how the SPA, server, store, audit ledger, and UNS engine fit together. |
| [`INDUSTRIAL_EDGE_PLATFORM_SPEC.md`](INDUSTRIAL_EDGE_PLATFORM_SPEC.md) | Industrial-edge spec — the "broker spine" that the Asset Dashboard work was built against (ISA-95 hierarchy, MQTT / OPC UA / SQL connectors, profiles + bindings). |
| [`SPEC_COMPLIANCE.md`](SPEC_COMPLIANCE.md) | Live compliance matrix between `PRODUCT_SPEC.md` clauses and the running code + tests. Update this any time a spec gap closes. |
| [`UX_AUDIT.md`](UX_AUDIT.md) | UX/UI audit + the seven-phase improvement plan (UX-A through UX-G). All seven phases shipped — the doc is now a historical record + design rationale for the patterns introduced (motion tokens, contrast contract, state primitives, utility classes, breadcrumb / idle / print). |

### Engineering policy

| Doc | Purpose |
|---|---|
| [`ENGINEERING_PHILOSOPHY.md`](ENGINEERING_PHILOSOPHY.md) | "Don't rebuild the wheel" — the open-source-first decision matrix every PR is expected to use. |
| [`THIRD_PARTY.md`](THIRD_PARTY.md) | License + provenance log for every third-party dependency. |
| [`OPEN_SOURCE_COMPETITIVE_ANALYSIS.md`](OPEN_SOURCE_COMPETITIVE_ANALYSIS.md) | Competitive landscape + how FORGE compares to alternative OSS in each pillar. |
| [`LICENSING.md`](LICENSING.md) | FORGE's licensing model + the per-feature license-flag implementation. |
| [`CHANGELOG.md`](CHANGELOG.md) | Notable user-visible changes per release. |
| [`AUDIT_LOG.md`](AUDIT_LOG.md) | Detailed engineering log per change — supplements `CHANGELOG.md` with the "why" behind each commit. |

### Security + compliance

| Doc | Purpose |
|---|---|
| [`THREAT_MODEL.md`](THREAT_MODEL.md) | Threat model — STRIDE walkthrough, trust boundaries, residual risks. |
| [`INCIDENT_RUNBOOK.md`](INCIDENT_RUNBOOK.md) | On-call runbook for security + availability incidents. |
| [`SLO.md`](SLO.md) | Service-level objectives — what FORGE commits to and how breaches are measured. |
| [`../SECURITY.md`](../SECURITY.md) | Public security policy + responsible-disclosure email. |

### Archived

| Doc | Why archived |
|---|---|
| [`archive/`](archive/) | Snapshots of completed audits (spec, enterprise-readiness, two-pass UX). Action items merged into `main`; preserved for decision-trail context. See [`archive/README.md`](archive/README.md). |

## House style

- Every doc starts with one paragraph stating its purpose. No "Welcome!" intros.
- Code references use full paths from the repo root: `server/routes/files.js:142` not `files.js`.
- Cross-references to other docs use the table-of-contents anchor pattern (see this file).
- Status tables use the same three buckets: ✅ Done · ◐ Partial · ○ Missing.
- When a finding lands, update the relevant doc *in the same PR* — don't let a stale claim sit on `main`.
