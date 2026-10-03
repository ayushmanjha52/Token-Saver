# TokenGrid

Metering gateway and coaching dashboard for AI token spend. See `CLAUDE.md`
for the product constraints every change must respect.

## Layout

| Path | What |
| --- | --- |
| `apps/gateway` | Fastify streaming proxy for Anthropic and OpenAI behind one `ProviderAdapter` interface (`src/providers/`); budget check before forwarding; emits usage to a Redis Stream after the response closes |
| `apps/ingest` | Stream consumer: prices each event by its timestamp, inserts it exactly once with its hourly rollup, maintains spend counters; `replay`, `redrive` and `budget` CLIs |
| `apps/web` | Next.js dashboard and `/api/usage` (consent and audit rules live in `src/lib/usage.ts`) |
| `packages/db` | Drizzle schema, migrations, seed, envelope encryption |
| `packages/shared` | Usage event format, exact (integer) cost math, budget keys |
| `tests/integration` | Acceptance suites on a throwaway Postgres 16; no Docker needed |

## Run locally

Requires Node 20.12+, pnpm 9, Postgres 16 and Redis 7 (`docker compose up -d` provides both).

```sh
pnpm install
cp .env.example .env          # fill TOKENGRID_LOCAL_KEK, TOKENGRID_SESSION_SECRET, SEED_ANTHROPIC_API_KEY
pnpm db:migrate
pnpm db:seed                  # prints a virtual key per demo user, once
pnpm dev:ingest               # terminal 1
pnpm dev:gateway              # terminal 2
pnpm dev:web                  # terminal 3 -> http://localhost:3000, sign in as e.g. manager@tokengrid.local
```

Point a client at the gateway with a virtual key:

```ts
const anthropic = new Anthropic({ apiKey: "tgk_...", baseURL: "http://localhost:8787/anthropic" }); // the bare root also works
const openai = new OpenAI({ apiKey: "tgk_...", baseURL: "http://localhost:8787/openai/v1" });
```

OpenAI routes need the org to have an OpenAI credential (`SEED_OPENAI_API_KEY` for the demo org).

The demo org has one team (Platform): a manager, members A, B and C (only A
allows individual drill-down) and an org admin.

## Tests

```sh
pnpm typecheck
pnpm test                     # unit tests
pnpm test:integration         # stage 1-4 acceptance on embedded Postgres 16
```

The integration suites use a real Postgres and the real gateway, worker and
dashboard code, with a fake Anthropic upstream and an in-memory Redis. Two
things they cannot cover need real infrastructure:

- **Cost vs. the Anthropic console** (spends real money, ~$0.25–$1):
  `TOKENGRID_KEY=tgk_... pnpm --filter @tokengrid/gateway acceptance:stage1`
  with the gateway and worker running. Use a key from a dedicated workspace.
- **Redis consumer-group behaviour** (reclaim after a crash, trimming):
  run `pnpm dev:ingest` against Redis 7, then `pnpm --filter @tokengrid/ingest replay` twice.

## Operating notes

- **Budgets** are monthly (UTC) per key, user or org:
  `pnpm --filter @tokengrid/ingest budget set --scope user --email a@tokengrid.local --limit 1.00`.
  Over the limit the gateway returns 402 naming the limit and spend; from 80% it adds
  `x-tokengrid-budget-warning`. Calls already in flight when the cap is crossed still
  complete, so spend can overshoot by their cost. If Redis is down the check fails open.
- **Price changes** are new `model_prices` rows dated at least 2 minutes ahead (workers
  cache prices for 60s; the database refuses anything sooner). Rows are append-only.
  A deliberate backfill sets `SET LOCAL tokengrid.allow_backdated_price = on`.
- **Missing price → DLQ.** Add the row, then `pnpm --filter @tokengrid/ingest redrive`.
- **Seed prices** were checked on 2026-09-25. Fast-mode rates are not seeded (cache
  rates for fast mode are not published), so fast-mode events wait in the DLQ.
- **Web search and other server-tool charges** are not priced yet; such events go to the
  DLQ rather than being stored at token cost only.
- **OpenAI specifics.** Streaming Chat Completions only report usage when
  `stream_options.include_usage` is true, so the gateway sets it on streaming requests.
  This is the one place a forwarded body is modified (`OpenAIAdapter.prepareBody`); the
  client receives one extra final chunk with empty `choices`. `prompt_tokens` includes
  cached and cache-write tokens, and both are subtracted. Snapshot model names
  (`gpt-6-sol-2026-08-01`) are priced as their model. Flex, priority/fast and
  long-context (over 272K prompt tokens) calls are separate price variants with no seeded
  rows, so they wait in the DLQ until verified prices are added.
- **Efficiency layer.** The gateway reduces each request to hashes and sizes after the
  response is delivered (no prompt text is stored or leaves the gateway). Clients can
  send `x-tokengrid-session: <conversation id>` to scope retry matching; without it a
  key is one session. A retry is a structurally identical final turn (same fingerprint,
  shape, numbers, simhash within 3 bits) within 15 minutes; the earlier response counts
  as wasted, charged to its own hour.
- **Lint findings** come from the trailing 7 days, scaled to a month. Every finding
  shows the spend it affects; a saving is shown only where prices make it computable
  (caching, model tier). Rules: uncached repeated prefix, short tasks on a frontier
  model, long answers with no format requested, large context for short answers,
  repeated workflow without a system prompt.
- **Efficiency score** = weighted retries (0.35), model fit (0.25), cache use (0.2),
  acceptance (0.2). A component with no measured input, such as acceptance until
  something reports it, has its weight redistributed and is shown as such. Every
  component is stored in `efficiency_scores`.
- **Privacy:** managers see team totals with unnamed per-person lines (hidden entirely
  below three other people), ordered by a per-period pseudonym rather than spend.
  Opening one person requires their consent, writes an audit row first, and is listed
  on that person's own dashboard.
