# Free-tier staging image for Render: gateway + ingest worker + a private
# Redis in one container, because Render's free plan offers one web service
# per app, no free background workers, and one free Key Value per workspace.
# Production uses the separate images in /Dockerfile instead.
FROM node:22-slim AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm build:services

FROM node:22-slim
# Debian's redis-server is Redis 7: streams and consumer groups as specified.
RUN apt-get update \
  && apt-get install -y --no-install-recommends redis-server \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/apps/gateway/dist ./apps/gateway/dist
COPY --from=build /app/apps/ingest/dist ./apps/ingest/dist
COPY --from=build /app/packages/db/dist ./packages/db/dist
COPY --from=build /app/packages/db/migrations ./packages/db/migrations
COPY deploy/render/start.mjs ./start.mjs
USER node
CMD ["node", "start.mjs"]
