FROM node:22-slim AS builder

WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/llm/package.json packages/llm/
COPY packages/agent/package.json packages/agent/
COPY packages/channels/package.json packages/channels/
COPY packages/tui/package.json packages/tui/
COPY packages/server/package.json packages/server/

RUN npm ci

COPY tsconfig.base.json ./
COPY packages/ packages/

RUN npm run build

FROM node:22-slim

WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/llm/package.json packages/llm/
COPY packages/agent/package.json packages/agent/
COPY packages/channels/package.json packages/channels/
COPY packages/tui/package.json packages/tui/
COPY packages/server/package.json packages/server/

RUN npm ci --omit=dev

COPY --from=builder /app/packages/llm/dist packages/llm/dist
COPY --from=builder /app/packages/agent/dist packages/agent/dist
COPY --from=builder /app/packages/channels/dist packages/channels/dist
COPY --from=builder /app/packages/server/dist packages/server/dist

CMD ["node", "packages/server/dist/index.js"]
