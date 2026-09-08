# syntax=docker/dockerfile:1
# Hosted relay + control plane image. One image, two entrypoints — the compose
# file picks `apps/relay/dist/main.js` or `apps/relay-control-plane/dist/main.js`.
# Build from the repository root:
#   docker build -f deploy/server/Dockerfile -t dash-server .

# ---- builder: full workspace install, build only what the two services need ----
FROM node:22-bookworm-slim AS builder
WORKDIR /app
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
COPY package.json package-lock.json tsconfig.base.json ./
COPY contracts/ contracts/
COPY packages/ packages/
COPY apps/ apps/
RUN npm ci --no-audit --no-fund
RUN npm run build -w packages/logging -w apps/relay -w apps/relay-control-plane
# Every workspace manifest, so the runtime `npm ci` sees the same workspace
# graph as the lockfile without copying any source.
RUN find . -name package.json -not -path '*/node_modules/*' \
      -exec sh -c 'mkdir -p "/manifests/$(dirname "$1")" && cp "$1" "/manifests/$1"' _ {} \;

# ---- runtime: production dependencies for the two services + built output ----
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /manifests/ ./
COPY package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
      -w packages/logging -w apps/relay -w apps/relay-control-plane \
    && npm cache clean --force
COPY --from=builder /app/packages/logging/dist packages/logging/dist
COPY --from=builder /app/apps/relay/dist apps/relay/dist
COPY --from=builder /app/apps/relay-control-plane/dist apps/relay-control-plane/dist
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
LABEL org.opencontainers.image.source="https://github.com/volumegambit/Dash"
CMD ["node", "apps/relay/dist/main.js"]
