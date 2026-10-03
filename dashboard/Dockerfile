# ==============================================================================
# Multi-stage Dockerfile cho Admin Dashboard (Fastify + Vite React 19)
# ==============================================================================

FROM node:22-alpine AS builder

WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.25.0 --activate

# Copy workspace metadata
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/db/package.json ./packages/db/
COPY dashboard/package.json ./dashboard/

# Cài đặt toàn bộ dependencies để build
RUN pnpm install --frozen-lockfile

# Copy mã nguồn
COPY packages/db ./packages/db
COPY dashboard ./dashboard

# Build Frontend Vite
RUN pnpm --filter plugin-vault-dashboard run build:client

# ------------------------------------------------------------------------------
# Production Runner (Tối ưu kích thước, siêu nhẹ, không cần Chrome)
# ------------------------------------------------------------------------------
FROM node:22-alpine AS runner

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0

RUN corepack enable && corepack prepare pnpm@11.25.0 --activate

COPY --from=builder /app/package.json /app/pnpm-workspace.yaml /app/pnpm-lock.yaml ./
COPY --from=builder /app/packages/db ./packages/db
COPY --from=builder /app/dashboard/package.json ./dashboard/
COPY --from=builder /app/dashboard/dist ./dashboard/dist
COPY --from=builder /app/dashboard/server ./dashboard/server
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dashboard/node_modules ./dashboard/node_modules

WORKDIR /app/dashboard

EXPOSE 3000

CMD ["pnpm", "start"]
