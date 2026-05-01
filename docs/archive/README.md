# Archived audit reports

Snapshots of completed audits, kept for historical reference. Action items from each have been merged into `main`. **None of these documents reflect current state** — they're preserved so future contributors can read the rationale behind decisions that landed.

| File | Original date | Successor / current state |
|---|---|---|
| [`AUDIT_REPORT-2026-04-25.md`](AUDIT_REPORT-2026-04-25.md) | 2026-04-25 | Spec-clause audit. Tracked completion of `PRODUCT_SPEC.md` items. Ongoing compliance is now in [`docs/SPEC_COMPLIANCE.md`](../SPEC_COMPLIANCE.md). |
| [`ENTERPRISE_READINESS_AUDIT-2026.md`](ENTERPRISE_READINESS_AUDIT-2026.md) | 2026 | Server-side enterprise-readiness review (security, multi-tenancy, observability). All P0/P1 items merged via Phase 1–7 of the Asset Dashboard work. Current state in [`docs/SERVER.md`](../SERVER.md), [`docs/THREAT_MODEL.md`](../THREAT_MODEL.md), and the test suite. |
| [`ENTERPRISE_UX_REDESIGN_AUDIT-2026.md`](ENTERPRISE_UX_REDESIGN_AUDIT-2026.md) | 2026 | Original full-app UX audit. Findings rolled into Phase-1 redesign work and then re-audited in [`docs/UX_AUDIT.md`](../UX_AUDIT.md) (the seven-phase UX-A through UX-G plan, fully delivered). |
| [`UX_AUDIT_TASKS-2026-04-25.md`](UX_AUDIT_TASKS-2026-04-25.md) | 2026-04-25 | Task tracker for the regulator-style accessibility audit (22 of 25 tasks closed). Superseded by [`docs/UX_AUDIT.md`](../UX_AUDIT.md). |

If you're researching how a specific decision landed, `git log -- <path>` against the original (pre-archive) location plus this directory will give you the full chain.
