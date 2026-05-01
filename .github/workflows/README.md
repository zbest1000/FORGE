# GitHub Actions workflows

Map of every workflow file in this directory, what it gates, and when it runs. Read this before touching any of the YAML — branch protection points at job names, so renames need to be coordinated with repo settings.

## Quick reference

| File | Job(s) | Trigger | Gating | Typical runtime |
|---|---|---|---|---|
| `ci.yml` | `lint` → `test` (matrix) → `audit`, `docker`, `ci-success` | push to `main`, PR → `main`, `merge_group`, `workflow_dispatch` | **Required** for merge (check `CI success`) | 6–14 min |
| `codeql.yml` | `analyze` (javascript-typescript + actions) | push, PR → `main`, weekly cron, `workflow_dispatch` | Soft gate (security alerts on findings; build fails on configured queries) | 1–3 min |
| `container-scan.yml` | `trivy` (filesystem + image scan, fail on `CRITICAL`) | push / PR with paths matching `Dockerfile`, `package*.json`, `server/**`, `src/**`; weekly cron | **Required** when Dockerfile or runtime deps change | 4–10 min |
| `dependency-review.yml` | `review` | PR → `main` only | Informational on this repo (GHAS not enabled — see comment in file). Auto-blocking on `high` once GHAS is on | < 1 min |
| `release.yml` | `archives` (matrix) → `sbom`, `container`, `release` | tag push `v*.*.*`, `workflow_dispatch` | Tag-driven, never blocks PRs | 15–30 min |
| `scorecard.yml` | `analysis` | weekly cron, push to `main`, branch-protection rule changes | Informational (publishes to OpenSSF Scorecard) | 1–3 min |
| `secret-scan.yml` | `gitleaks` | push, PR → `main`, weekly cron | **Required** for merge | < 1 min |

## Required vs. informational

Branch protection on `main` requires the following job names to succeed before merge:

- `CI success` (the aggregate gate at the end of `ci.yml`)
- `CodeQL`
- `Gitleaks`
- `Trivy vulnerability scan` (when paths trigger `container-scan.yml`)

Everything else surfaces signal but doesn't block the merge button. The `npm audit (production)` job inside `ci.yml` is a deliberate exception — it's `continue-on-error: true` because we depend on packages whose advisories are unfixable upstream (see the comment near `audit` in `ci.yml`).

## Action pinning policy

Every third-party action in this directory is pinned to a full commit SHA with the human-readable version in a trailing comment, e.g.:

```yaml
- uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2
```

The SHA is the source of truth — the comment is for reviewers. Bumping a pin is a deliberate, reviewable change. **Don't use floating tags** (`@v6` or `@main`) — Scorecard penalises us for it and a compromised tag can silently inject malicious code into the runner.

When upgrading an action, update every workflow that uses it in the same PR so the SHA stays consistent across files.

## Per-workflow notes

### `ci.yml` — primary build + test gate

Five jobs:

1. **`lint`** — `node --check` on every JS source file plus `tsc --noEmit` on the client surface.
2. **`test`** — matrix across Node 20.x + 22.x and ubuntu / macos / windows. Builds the SPA, migrates the schema, runs `npm test`, smokes the built server, then re-imports every server module to catch module-load-time errors that a happy-path test wouldn't see.
3. **`audit`** — `npm audit --omit=dev --audit-level=high`, non-blocking (see comment).
4. **`docker`** — builds the image with Buildx, runs the container, polls `/api/health` until it returns 200 or times out at 15 attempts × 2 seconds.
5. **`ci-success`** — aggregate `needs:` gate. Branch protection points at this single name so adding/removing matrix entries doesn't break the rule.

Concurrency group cancels in-flight runs for the same ref.

### `codeql.yml` — security scanning

Runs the `security-extended` + `security-and-quality` query packs against `javascript-typescript` and `actions`. Findings appear in the GitHub Security tab; some queries fail the build (e.g. SQL injection, hardcoded secrets), most surface as advisories.

### `container-scan.yml` — Trivy

Two scans, both with `severity: CRITICAL,HIGH` and `ignore-unfixed: true`:

1. Filesystem scan (`vuln,secret,misconfig`) — surfaces dependency CVEs, leaked secrets in source, and Docker / IaC misconfigurations.
2. Image scan — runs against the built `forge:scan` image to catch base-image and runtime-layer CVEs.

Both upload SARIF for the Security tab. A separate `Fail on CRITICAL findings` step gates the merge.

### `dependency-review.yml` — license + dep severity

Currently `continue-on-error: true` because the GitHub Dependency Review API requires GitHub Advanced Security on private repos. When GHAS is enabled, flip the flag and this becomes a hard gate. The license deny-list excludes copyleft families (AGPL, GPL) that would change FORGE's redistribution terms.

### `release.yml` — tag-driven release

Triggered by pushing a tag matching `v*.*.*`. Builds:

- Platform-native archives (Linux x64, macOS arm64 + x64, Windows x64) with `node_modules`, `dist/`, runtime files, and convenience launchers.
- CycloneDX SBOM.
- Multi-arch container image (`linux/amd64`, `linux/arm64`) pushed to GHCR, signed with cosign keyless (Sigstore Fulcio + Rekor), with build-provenance attestation.
- A draft GitHub Release aggregating all artifacts plus a `SHA256SUMS` manifest.

Manual `workflow_dispatch` is supported for dry-runs. The release publishes as a **draft** so a human reviews + clicks "Publish" before users can download.

### `scorecard.yml` — OSSF Scorecard

Once weekly (Monday 07:00 UTC), plus on push to `main` and branch-protection rule changes. Publishes the score to the OpenSSF Scorecard public API and uploads SARIF for the Security tab. Used as an external trust signal for downstream consumers.

### `secret-scan.yml` — Gitleaks

Full git-history scan (`fetch-depth: 0`) on every PR + weekly cron. The action no-ops on unlicensed orgs > 1 user; we keep it permissive for forks. Findings block the merge.

## Conventions

- **Permissions**: every workflow declares `permissions: contents: read` at the top and elevates per-job only when needed (`security-events: write`, `id-token: write`, etc.).
- **Concurrency**: every workflow declares a concurrency group keyed on `${{ github.ref }}` so in-flight runs cancel when a new push arrives. Release is the exception — `cancel-in-progress: false` so a tag push always finishes.
- **`HUSKY=0`**: set in `env:` blocks for jobs that run `npm ci` so husky's git hooks don't try to install in CI.
- **Secrets**: only `GITHUB_TOKEN` is consumed. No third-party tokens are required for any workflow.
