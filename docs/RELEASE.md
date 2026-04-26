# FORGE Build and Release Flow

FORGE is now a build-first SPA plus Fastify server. Source-module serving is a
local development fallback only; production releases must ship `dist/`.

## Branch flow

1. Branch from `main`.
2. Keep commits scoped to one logical change.
3. Before opening or updating a PR, run:
   ```bash
   npm run release:check
   ```
4. Push with:
   ```bash
   git push -u origin <branch>
   ```
5. Open/update a PR against `main`.

## Release verification

`npm run release:check` runs:

1. `npm run build` — creates the hashed Vite bundle in `dist/`.
2. `npm test` — runs the Node test suite.
3. `npm run smoke:built` — starts Fastify against the built bundle on port
   `3100`, checks `/api/health`, and verifies `/` serves built asset paths.

## Production rules

- `npm start` requires `dist/index.html` by default.
- If `dist/` is missing, the server exits instead of serving source files.
- Local source-module development must be explicit:
  `FORGE_SERVE_SOURCE=1 npm start`, or `npm run dev`.

## Docker release

Docker builds run `npm install`, `npm run build`, prune dev dependencies, and
then copy only the runtime server, `dist/`, package metadata, docs, and
production dependencies into the final image.
