FROM node:20-bookworm-slim AS builder
WORKDIR /app
RUN apt-get update -qq && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund

FROM node:20-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
RUN apt-get update -qq && apt-get install -y --no-install-recommends ca-certificates tini \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /app/data && chown -R node:node /app

COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node . .

USER node
EXPOSE 7100
VOLUME ["/app/data"]
HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:7100/healthz').then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "main.js"]
