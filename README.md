# TokenGrid

Metering gateway for AI token spend. See `CLAUDE.md` for the product
constraints every change must respect.

## Layout

| Path | What |
| --- | --- |
| `apps/gateway` | Fastify streaming proxy for Anthropic `/v1/messages`; emits usage to a Redis Stream after the response closes |
| `apps/ingest` | Stream consumer: prices each event by its timestamp and inserts it exactly once |
| `packages/db` | Drizzle schema, migrations, seed, envelope encryption |
| `packages/shared` | Usage event format and exact (integer) cost math |

## Run locally

Requires Node 20.11+, pnpm 9, Postgres 16 and Redis 7 (`docker compose up -d` provides both).

```sh
pnpm install
cp .env.example .env          # fill TOKENGRID_LOCAL_KEK and SEED_ANTHROPIC_API_KEY
pnpm db:migrate
pnpm db:seed                  # prints the demo virtual key once
pnpm dev:ingest               # terminal 1
pnpm dev:gateway              # terminal 2
```

Point any Anthropic client at the gateway with the virtual key:

```ts
const client = new Anthropic({ apiKey: "tgk_...", baseURL: "http://localhost:8787" });
```

## Stage 1 acceptance

```sh
TOKENGRID_KEY=tgk_... pnpm --filter @tokengrid/gateway acceptance:stage1
pnpm --filter @tokengrid/ingest replay      # run twice; usageEventsAfter must equal usageEventsBefore
```

The script sends 20 real requests (streaming and not, cached and not),
checks every one was stored exactly once at a cost equal to what the SDK's
own `usage` implies, and prints today's total to compare with the Anthropic
console. Use a key from a dedicated workspace so the console figure contains
nothing else.

## Operating notes

- **Missing price → DLQ.** Add a `model_prices` row, then
  `pnpm --filter @tokengrid/ingest redrive`.
- **Prices in the seed** were checked on 2026-09-25 and take effect from that
  date. Fast-mode rates are deliberately not seeded (cache rates for fast mode
  are not published), so fast-mode events wait in the DLQ until verified rows
  exist.
- **Web search and other server-tool charges** are not yet priced; events
  carrying them go to the DLQ rather than being stored at token cost only.
