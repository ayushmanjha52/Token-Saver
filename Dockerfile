# One build, three runtime images:
#   docker build --target gateway -t tokengrid-gateway .
#   docker build --target ingest  -t tokengrid-ingest  .
#   docker build --target web     -t tokengrid-web     .
# Runtime images hold bundled JavaScript only: no TypeScript toolchain, no
# pnpm, and for gateway/ingest no node_modules.

FROM node:22-slim AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm build:services && NEXT_OUTPUT=standalone pnpm build:web

FROM node:22-slim AS gateway
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/apps/gateway/dist ./dist
USER node
EXPOSE 8787
# Long-lived streams: the platform must allow minutes-long requests and send
# SIGTERM with a generous grace period so in-flight streams can finish.
CMD ["node", "--enable-source-maps", "dist/index.js"]

FROM node:22-slim AS ingest
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/apps/ingest/dist ./apps/ingest/dist
COPY --from=build /app/packages/db/dist ./packages/db/dist
COPY --from=build /app/packages/db/migrations ./packages/db/migrations
USER node
# Operator CLIs ship in this image: node apps/ingest/dist/admin-cli.js ..., node packages/db/dist/migrate.js
CMD ["node", "--enable-source-maps", "apps/ingest/dist/worker.js"]

FROM node:22-slim AS web
WORKDIR /app
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0
COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static ./apps/web/.next/static
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
