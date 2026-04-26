# Contributing to FORGE

Welcome — and thank you. Two things to read before you write any code:

1. **`docs/ENGINEERING_PHILOSOPHY.md`** — this is the **rule**, not a
   suggestion. Every PR (including AI-generated ones) is expected to
   follow the decision matrix and the per-concern OSS register.
2. **`PRODUCT_SPEC.md`** — the source of truth for what FORGE is.

## Pre-flight checklist (paste into your PR description)

- [ ] What spec clause does this implement?
- [ ] Which row of the OSS register applies?
      (See `docs/ENGINEERING_PHILOSOPHY.md` §6.)
- [ ] If no row applies, did I search npm / GitHub for prior art?
      Result: _link or N/A_.
- [ ] Did I file the dep in `docs/THIRD_PARTY.md`?
- [ ] Did I add the seam (single import site / wrapper module)?
- [ ] Did I add a non-fatal fallback if the dep is unavailable?
- [ ] Did I update `docs/AUDIT_LOG.md` with what / why / tech / files
      / verification?
- [ ] Did I update `docs/SPEC_COMPLIANCE.md` if a clause moved?
- [ ] Are tests in `test/` exercising the new path?
- [ ] `npm test` is green?
- [ ] `node --check` clean on every changed module?

## Development

```bash
npm install
npm run seed     # one-time
npm run dev      # node --watch server/main.js
npm run build    # production SPA bundle
npm run verify   # build + tests + built-server smoke
npm test         # node --test
```

## Branch and commit conventions

- Branch from `main`; name as `cursor/<topic>-<slug>` for cloud agents,
  or anything descriptive otherwise.
- Each commit is one logical change; messages start with `feat:`,
  `fix:`, `docs:`, `test:`, `refactor:`, `chore:`, …

## Code style

- ES modules with Vite for production bundling.
- No new npm dep without a row in the OSS register.
- Wrap third-party imports behind a single seam module so the rest of
  the codebase stays portable.

## When in doubt

Open `docs/ENGINEERING_PHILOSOPHY.md` and walk the decision matrix.
That's the reason it's a living document.
