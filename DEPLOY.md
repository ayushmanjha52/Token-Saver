# Deploying TokenGrid

Three processes and two stores:

| Piece | Where | Why there |
| --- | --- | --- |
| Gateway (`apps/gateway`) | Persistent host: Fly.io, Railway, ECS | Holds streaming connections for minutes. Serverless platforms cut them off and cold-start in the request path. |
| Ingest worker (`apps/ingest`) | Same persistent host, no public port | Long-running Redis Stream consumer; also runs reconciliation, retention and score jobs. |
| Dashboard (`apps/web`) | Vercel, or the `web` image | Short request/response only. |
| PostgreSQL 16 | Managed (RDS, Neon, Crunchy) | Partitioned `usage_events`. |
| Redis 7 | Managed with persistence (Upstash, ElastiCache) | Unacknowledged usage events live only in the stream; enable AOF or equivalent. |

Provider credentials are envelope-encrypted with **AWS KMS**. The local
development key refuses to run when `NODE_ENV=production`.

## Environment

| Variable | Gateway | Worker | Dashboard | Notes |
| --- | --- | --- | --- | --- |
| `DATABASE_URL` | yes | yes | yes | Postgres 16 |
| `DATABASE_PREPARE=false` | | | if pooled | Set when the URL goes through a transaction-mode pooler |
| `REDIS_URL` | yes | yes | | |
| `TOKENGRID_KMS_KEY_ID` | yes | yes (and CLIs) | | Symmetric KMS key ARN or alias |
| `AWS_REGION` (+ role or keys) | yes | yes | | IAM: `kms:GenerateDataKey`, `kms:Decrypt` on that key |
| `TOKENGRID_SESSION_SECRET` | | for `login-link` | yes | 32+ random characters, same value everywhere |
| `ALERT_WEBHOOK_URL` | | optional | | Reconciliation drift alerts (Slack-compatible `text`) |
| `ANTHROPIC_UPSTREAM_URL`, `OPENAI_UPSTREAM_URL` | optional | | | Defaults to the public APIs |

A KMS key policy that restricts use to TokenGrid's encryption context:

```json
{ "Condition": { "StringEquals": { "kms:EncryptionContext:purpose": "tokengrid-provider-credential" } } }
```

## Managed deployment (Fly.io + Vercel)

```sh
# 1. Stores: create Postgres 16 and Redis 7 (with persistence). Note both URLs.
# 2. KMS: create a symmetric key; give the Fly apps an IAM identity that can use it.

# 3. Worker. Migrations run as its release command before new code starts.
fly apps create tokengrid-ingest
fly secrets set -a tokengrid-ingest DATABASE_URL=... REDIS_URL=... TOKENGRID_KMS_KEY_ID=... AWS_REGION=... \
  AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... TOKENGRID_SESSION_SECRET=... ALERT_WEBHOOK_URL=...
fly deploy --config deploy/fly.ingest.toml

# 4. Gateway.
fly apps create tokengrid-gateway
fly secrets set -a tokengrid-gateway DATABASE_URL=... REDIS_URL=... TOKENGRID_KMS_KEY_ID=... AWS_REGION=... \
  AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=...
fly deploy --config deploy/fly.gateway.toml
curl https://tokengrid-gateway.fly.dev/healthz        # {"ok":true,...}
```

5. **Dashboard on Vercel.** Import the repository and set:
   - Root directory: `apps/web`
   - Install command: `cd ../.. && pnpm install --frozen-lockfile`
   - Build command: `cd ../.. && pnpm --filter @tokengrid/web build`
   - Env: `DATABASE_URL` (pooled), `DATABASE_PREPARE=false`, `TOKENGRID_SESSION_SECRET`

6. **First org.** Run the CLIs inside the worker image:

```sh
fly ssh console -a tokengrid-ingest
node apps/ingest/dist/admin-cli.js org create --name "Acme" --admin-email ops@acme.com --admin-name "Ops"
TOKENGRID_CREDENTIAL=sk-ant-... node apps/ingest/dist/credential-cli.js --email ops@acme.com --provider anthropic
TOKENGRID_CREDENTIAL=sk-ant-admin01-... node apps/ingest/dist/credential-cli.js --email ops@acme.com \
  --provider anthropic --kind admin --scope <workspace id of the key above>      # reconciliation (optional)
node apps/ingest/dist/admin-cli.js team member --org "Acme" --team Platform --email ops@acme.com --role manager
node apps/ingest/dist/admin-cli.js key issue --email ops@acme.com --name laptop
node apps/ingest/dist/admin-cli.js login-link --email ops@acme.com --base-url https://tokengrid.acme.com
```

7. **Verify.** Send one call through the gateway with the issued key, open the
   sign-in link (one use, 15 minutes), and the call appears on the dashboard
   within seconds.

```sh
curl https://tokengrid-gateway.fly.dev/anthropic/v1/messages -H "x-api-key: tgk_..." \
  -H "anthropic-version: 2023-06-01" -H "content-type: application/json" \
  -d '{"model":"claude-haiku-4-5","max_tokens":32,"messages":[{"role":"user","content":"ping"}]}'
```

## Free staging (Render + Neon + Vercel, no payment method)

A staging deployment on free tiers. It is **not production**: it runs with the
local encryption key (`NODE_ENV=staging`) because no major cloud offers KMS
without a card, and the free Render instance sleeps after 15 idle minutes (the
first call afterwards waits about a minute).

- **Neon** (Postgres): migrations and admin CLIs use the direct URL; the dashboard
  uses the pooled URL with `DATABASE_PREPARE=false`.
- **Render** (one free web service): `deploy/render/Dockerfile` runs the gateway,
  the worker and a private in-memory Redis 7 in one container, supervised by
  `deploy/render/start.mjs`. Render allows one free Key Value per workspace and no
  free background workers. Env: `NODE_ENV=staging`, `DATABASE_URL` (direct),
  `TOKENGRID_LOCAL_KEK`.
- **Vercel** (Hobby): project root `apps/web`; env `DATABASE_URL` (pooled),
  `DATABASE_PREPARE=false`, `TOKENGRID_SESSION_SECRET`. Deployed with
  `vercel deploy --prod` from the repo root (`.vercelignore` trims the upload).
- **Bootstrap** from any machine with the repo, using the same `TOKENGRID_LOCAL_KEK`
  and `TOKENGRID_SESSION_SECRET` as the services and `NODE_ENV=staging`:
  `node packages/db/dist/migrate.js`, then the admin CLI commands in step 6 above.

## Single host (Docker Compose)

```sh
cp deploy/prod.env.example deploy/prod.env      # fill it
docker compose -f deploy/docker-compose.prod.yml --env-file deploy/prod.env up -d --build
docker compose -f deploy/docker-compose.prod.yml exec ingest node apps/ingest/dist/admin-cli.js org create ...
```

Then steps 6 and 7 above, with `docker compose ... exec ingest` in place of `fly ssh console`.

## Rehearsal without Docker

This is what `tests/integration/src/stage6.ts` automates: a cold start from an empty
database to a working dashboard, using the production bundles. It uses the local
development key instead of KMS, so the gateway and worker run without
`NODE_ENV=production`; everything else matches the managed deployment.

```sh
pnpm install --frozen-lockfile && pnpm build:services && pnpm build:web
export DATABASE_URL=postgres://... REDIS_URL=redis://... TOKENGRID_LOCAL_KEK=... TOKENGRID_SESSION_SECRET=...
node packages/db/dist/migrate.js
node apps/ingest/dist/admin-cli.js org create --name "Acme" --admin-email ops@acme.com --admin-name "Ops"
TOKENGRID_CREDENTIAL=sk-ant-... node apps/ingest/dist/credential-cli.js --email ops@acme.com --provider anthropic
node apps/ingest/dist/admin-cli.js key issue --email ops@acme.com
node apps/gateway/dist/index.js &
node apps/ingest/dist/worker.js &
(cd apps/web && pnpm start) &
node apps/ingest/dist/admin-cli.js login-link --email ops@acme.com --base-url http://localhost:3000
```

## Operating notes

- **Deploys drain.** The gateway stops accepting on SIGTERM and lets in-flight streams
  finish; `kill_timeout` is 300 s on Fly and `stop_grace_period` 300 s in Compose.
- **Scaling.** Gateways are stateless; run two or more. Several workers share the
  consumer group safely; reconciliation and retention are idempotent across them.
- **Rotating the KMS key or moving off the local key.** Re-store each credential with
  `credential-cli.js`; it rotates the row and encrypts under the current key.
- **Sign-in** is by one-time links until an identity provider is wired into
  `apps/web/src/lib/session.ts`.
