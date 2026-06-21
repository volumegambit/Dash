# syntax=docker/dockerfile:1

# ---- Builder stage: install all deps and compile every workspace ----
FROM node:22-slim AS builder

WORKDIR /app

# Copy the root manifest + lockfile, then every package manifest, so `npm ci`
# can resolve the workspace graph and stays in a cacheable layer. The runtime
# entrypoint is apps/gateway; the other apps (mission-control, website,
# waitlist) are not needed to build or run the gateway, so they are omitted —
# the `apps/*` glob in package.json matches only the directories present here.
COPY package.json package-lock.json ./
COPY packages/agent/package.json packages/agent/
COPY packages/channels/package.json packages/channels/
COPY packages/chat/package.json packages/chat/
COPY packages/logging/package.json packages/logging/
COPY packages/management/package.json packages/management/
COPY packages/mc/package.json packages/mc/
COPY packages/mcp/package.json packages/mcp/
COPY packages/models/package.json packages/models/
COPY packages/paths/package.json packages/paths/
COPY packages/projects/package.json packages/projects/
COPY packages/skills/package.json packages/skills/
COPY apps/gateway/package.json apps/gateway/

RUN npm ci

# Copy sources and build the packages + gateway. Build order is owned by the
# root "build" script.
COPY tsconfig.base.json ./
COPY packages/ packages/
COPY apps/gateway/ apps/gateway/

RUN npm run build

# ---- Runtime stage: production deps + compiled output only ----
FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/agent/package.json packages/agent/
COPY packages/channels/package.json packages/channels/
COPY packages/chat/package.json packages/chat/
COPY packages/logging/package.json packages/logging/
COPY packages/management/package.json packages/management/
COPY packages/mc/package.json packages/mc/
COPY packages/mcp/package.json packages/mcp/
COPY packages/models/package.json packages/models/
COPY packages/paths/package.json packages/paths/
COPY packages/projects/package.json packages/projects/
COPY packages/skills/package.json packages/skills/
COPY apps/gateway/package.json apps/gateway/

RUN npm ci --omit=dev

COPY --from=builder /app/packages/agent/dist packages/agent/dist
COPY --from=builder /app/packages/channels/dist packages/channels/dist
COPY --from=builder /app/packages/chat/dist packages/chat/dist
COPY --from=builder /app/packages/logging/dist packages/logging/dist
COPY --from=builder /app/packages/management/dist packages/management/dist
COPY --from=builder /app/packages/mc/dist packages/mc/dist
COPY --from=builder /app/packages/mcp/dist packages/mcp/dist
COPY --from=builder /app/packages/models/dist packages/models/dist
COPY --from=builder /app/packages/paths/dist packages/paths/dist
COPY --from=builder /app/packages/projects/dist packages/projects/dist
COPY --from=builder /app/packages/skills/dist packages/skills/dist
COPY --from=builder /app/apps/gateway/dist apps/gateway/dist

# Root for everything Dash stores on disk (read by @dash/paths). Matches the
# DASH_HOME + dash-data volume mount point declared in docker-compose.yml.
ENV DASH_HOME=/data

CMD ["node", "apps/gateway/dist/index.js"]
