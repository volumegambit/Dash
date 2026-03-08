FROM node:22-slim AS builder

WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/agent/package.json packages/agent/
COPY packages/channels/package.json packages/channels/
COPY packages/management/package.json packages/management/
COPY packages/mc/package.json packages/mc/
COPY apps/dash/package.json apps/dash/
COPY apps/tui/package.json apps/tui/
COPY apps/mc-cli/package.json apps/mc-cli/

RUN npm ci

COPY tsconfig.base.json ./
COPY packages/ packages/
COPY apps/ apps/

RUN npm run build

FROM node:22-slim

WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/agent/package.json packages/agent/
COPY packages/channels/package.json packages/channels/
COPY packages/management/package.json packages/management/
COPY packages/mc/package.json packages/mc/
COPY apps/dash/package.json apps/dash/
COPY apps/tui/package.json apps/tui/
COPY apps/mc-cli/package.json apps/mc-cli/

RUN npm ci --omit=dev

COPY --from=builder /app/packages/agent/dist packages/agent/dist
COPY --from=builder /app/packages/channels/dist packages/channels/dist
COPY --from=builder /app/packages/management/dist packages/management/dist
COPY --from=builder /app/packages/mc/dist packages/mc/dist
COPY --from=builder /app/apps/dash/dist apps/dash/dist

CMD ["node", "apps/dash/dist/index.js"]
