# FORGE — Docker image
#
# Multi-stage build. Final image is ~80 MB compressed.
# Supports:
#   docker build -t forge .
#   docker run -p 3000:3000 -v forge-data:/app/data forge
#
# Environment variables (see .env.example):
#   PORT                    default 3000
#   FORGE_JWT_SECRET        required for production
#   FORGE_TENANT_KEY        HMAC key for audit pack signing
#   FORGE_DATA_DIR          default /app/data (volume mount recommended)
#   FORGE_MQTT_URL          optional MQTT bridge
#   FORGE_CORS_ORIGIN       comma-separated origins; default '*'

FROM node:20-bookworm-slim AS builder
WORKDIR /app

# Build tools for better-sqlite3 native binding.
RUN apt-get update -qq \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm install --omit=dev --omit=optional --no-audit --no-fund

FROM node:20-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app

# Runtime libs for native bindings. `libredwg-tools` provides `dwg2dxf`
# (GPL-3.0; runs as a subprocess so its license affects only its own
# binary, not FORGE's code) but is not always available in the base
# image's apt sources (e.g. Debian bookworm where it is still ITP).
# Install it best-effort: when missing, the server falls back to a
# "converter not installed" response (see server/converters/dwg.js).
RUN apt-get update -qq \
 && apt-get install -y --no-install-recommends ca-certificates tini \
 && (apt-get install -y --no-install-recommends libredwg-tools \
      || echo "WARN: libredwg-tools unavailable; DWG → DXF conversion will be disabled. Set FORGE_DWG2DXF to override.") \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /app/data && chown -R node:node /app

COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node index.html styles.css app.js ./
COPY --chown=node:node src ./src
COPY --chown=node:node server ./server
COPY --chown=node:node docs ./docs
COPY --chown=node:node PRODUCT_SPEC.md README.md LICENSE ./

USER node
EXPOSE 3000
VOLUME ["/app/data"]

HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server/main.js"]
