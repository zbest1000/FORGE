# FORGE — Engineering Audit Log

A detailed, chronological record of the changes made to bring FORGE into
alignment with `PRODUCT_SPEC.md`. Each entry describes what was done, why,
the technology choice and rationale, the file(s) touched, and how it was
verified.

New entries are appended in time order. Each entry corresponds to one git
commit on this branch. The commit hash is back-filled after commit.

---

## 2026-04-24 — Baseline

Starting state (already on this branch):
- `app.js`, `src/core/*`, `src/shell/*`, `src/screens/*` from prior commits
  `149a74f` (FORGE MVP) and `5ece325` (UNS + i3X 1.0-Beta).
- Prototype is a static client app. `python3 -m http.server 8080` runs it.

## 2026-04-24 — Spec gap analysis + docs scaffolding

**What**
Re-read PRODUCT_SPEC.md end-to-end. Produced a full compliance matrix
(`docs/SPEC_COMPLIANCE.md`) and an architecture doc (`docs/ARCHITECTURE.md`).
Identified concrete gaps against §4 base fields, §7 revision detail, §8
drawing viewer features, §9 event pipeline, §10 workflows, §11 screens,
§13 signed-audit, §14 AI, §15 search.

**Why**
Without a single source of truth, it is impossible to claim "matches spec".
The compliance matrix is kept up to date with every subsequent commit.

**Tech decisions made**
- Zero npm deps. Pure browser ES modules, `Web Crypto`, `IndexedDB`, SVG.
- Hash-chained audit ledger (SHA-256) for tamper-evidence.
- HMAC-SHA256 signatures for approvals and audit-pack export.
- BM25 inverted index for unified search.
- In-process event envelope + DLQ + replay.
- Revision lifecycle as a formal state machine.

**Files**
- Added `docs/ARCHITECTURE.md`
- Added `docs/SPEC_COMPLIANCE.md`
- Added `docs/AUDIT_LOG.md` (this file)
- Added `docs/CHANGELOG.md`

**Verification**
- `node --check` on existing modules still passes.
- Prior runtime smoke tests unaffected.

---

<!--
Subsequent entries follow this template:

## YYYY-MM-DD — <short title> (<commit-hash>)

**What** — one paragraph.
**Why** — which spec clauses are addressed.
**Tech decision** — chosen approach + alternatives considered.
**Files** — list.
**Verification** — how it was tested.
-->
