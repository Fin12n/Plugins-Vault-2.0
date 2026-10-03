# ==============================================================================
# Multi-stage Dockerfile cho Discord Bot & CloakBrowser Upstream Worker
# ==============================================================================

FROM node:24-bookworm-slim AS builder

WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.25.0 --activate

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/db/package.json ./packages/db/
COPY discord/package.json ./discord/

RUN pnpm install --frozen-lockfile

COPY packages/db ./packages/db
COPY discord ./discord

RUN pnpm --filter plugin-vault-bot run build

# ------------------------------------------------------------------------------
# Production Runner
# ------------------------------------------------------------------------------
FROM node:24-bookworm-slim AS runner

WORKDIR /app
ENV NODE_ENV=production

# CloakBrowser + Chromium runtime libraries & Xvfb
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        wget \
        fonts-liberation \
        xvfb \
        procps \
        libnss3 \
        libatk1.0-0 \
        libatk-bridge2.0-0 \
        libcups2 \
        libdrm2 \
        libxkbcommon0 \
        libxcomposite1 \
        libxdamage1 \
        libxfixes3 \
        libxrandr2 \
        libgbm1 \
        libpango-1.0-0 \
        libcairo2 \
        libasound2 \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@11.25.0 --activate

COPY --from=builder /app/package.json /app/pnpm-workspace.yaml /app/pnpm-lock.yaml ./
COPY --from=builder /app/packages/db ./packages/db
COPY --from=builder /app/discord/package.json ./discord/
COPY --from=builder /app/discord/dist ./discord/dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/discord/node_modules ./discord/node_modules

WORKDIR /app/discord

CMD ["node", "dist/src/index.js"]
