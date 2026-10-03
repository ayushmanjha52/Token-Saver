/**
 * Stage 1 acceptance, minus the real-money half: real Postgres 16, a fake
 * Anthropic upstream, and the real gateway and ingest code. The comparison
 * against the Anthropic console is apps/gateway/scripts/stage1-acceptance.ts.
 */
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { count, isNull, sql as dsql } from "drizzle-orm";
import { Agent } from "undici";
import { CATALOG, createDb, schema } from "@tokengrid/db";
import { COST_SCALE, computeCost, formatDecimal, type UsageEventV1 } from "@tokengrid/shared";
import { BudgetGuard } from "../../../apps/gateway/src/budget.js";
import { AnthropicAdapter } from "../../../apps/gateway/src/providers/anthropic.js";
import { VirtualKeyResolver } from "../../../apps/gateway/src/auth.js";
import { UsageEmitter } from "../../../apps/gateway/src/emit.js";
import { createApp, registerRoutes } from "../../../apps/gateway/src/server.js";
import { processEntry } from "../../../apps/ingest/src/process.js";
import { PriceCache } from "../../../apps/ingest/src/prices.js";
import { Checks, FakeRedis, one, pnpm, seededKeys, sleep, startPostgres, testEnv } from "./harness.js";

const OPUS_55 = { inputPerMtok: "4", outputPerMtok: "20", cacheReadPerMtok: "0.20", cacheWrite5mPerMtok: "5", cacheWrite1hPerMtok: "8" };
const quiet = { warn: () => {}, error: () => {} };

const pg = await startPostgres();
const env = testEnv(pg.url);
const checks = new Checks();

try {
  pnpm(["db:migrate"], env);
  const vkey = seededKeys(pnpm(["db:seed"], env))["a@tokengrid.local"];
  assert.ok(vkey, "seed printed a virtual key");
  pnpm(["db:seed"], env);

  // One connection, so the session-level backfill opt-in below applies to every statement.
  const { db, sql } = createDb(undefined, { max: 1 });
  await sql`select set_config('tokengrid.allow_backdated_price', 'on', false)`;
  assert.equal(one(await db.select({ n: count() }).from(schema.modelPrices), "price count").n, CATALOG.length);
  checks.ok(`migrate + seed (twice) -> ${CATALOG.length} price rows, no duplicates`);

  const parts = await sql<{ relname: string }[]>`
    select c.relname from pg_inherits i
    join pg_class c on c.oid = i.inhrelid join pg_class p on p.oid = i.inhparent
    where p.relname = 'usage_events' order by 1`;
  assert.equal(parts.length, 4);
  checks.ok(`usage_events partitioned: ${parts.map((r) => r.relname).join(", ")}`);

  // ---- fake Anthropic upstream ----
  let reqN = 0;
  const seenBodies: string[] = [];
  const sentBodies: Buffer[] = [];
  let upstreamAborted = false;
  const upstream = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", async () => {
      const raw = Buffer.concat(chunks).toString();
      seenBodies.push(raw);
      assert.equal(req.headers["x-api-key"], "sk-ant-fake-upstream");
      const body = JSON.parse(raw) as { model: string; stream?: boolean; metadata?: { user_id?: string } };
      const id = `req_${++reqN}`;
      const usageStart = {
        input_tokens: 100 + reqN,
        output_tokens: 1,
        cache_read_input_tokens: 2000,
        cache_creation_input_tokens: 300,
        cache_creation: { ephemeral_5m_input_tokens: 300, ephemeral_1h_input_tokens: 0 },
      };
      if (!body.stream) {
        const out = Buffer.from(
          JSON.stringify({ id: `msg_${reqN}`, type: "message", model: body.model, stop_reason: "end_turn", content: [{ type: "text", text: "hi" }], usage: { ...usageStart, output_tokens: 50 } }),
        );
        sentBodies.push(out);
        res.writeHead(200, { "content-type": "application/json", "request-id": id });
        res.end(out);
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream", "request-id": id });
      const ev = (e: string, d: unknown) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`;
      const all = Buffer.from(
        [
          ev("message_start", { type: "message_start", message: { id: `msg_${reqN}`, type: "message", model: body.model, usage: usageStart } }),
          ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello wörld ✓" } }),
          ev("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 777 } }),
          ev("message_stop", { type: "message_stop" }),
        ].join(""),
      );
      sentBodies.push(all);
      res.on("close", () => {
        if (!res.writableFinished) upstreamAborted = true;
      });
      // Odd chunk boundaries, with delays, to exercise streaming.
      const slow = body.metadata?.user_id === "slow";
      for (let i = 0; i < all.length; i += 37) {
        if (res.destroyed) return;
        res.write(all.subarray(i, i + 37));
        await sleep(slow ? 40 : 2);
      }
      res.end();
    });
  });
  await new Promise<void>((r) => upstream.listen(0, r));
  const upstreamAddr = upstream.address();
  assert.ok(upstreamAddr && typeof upstreamAddr === "object");

  const redis = new FakeRedis();
  const app = createApp({ logger: false });
  const emitter = new UsageEmitter(redis.asRedis(), quiet);
  registerRoutes(app, {
    resolver: new VirtualKeyResolver(redis.asRedis(), db, quiet),
    emitter,
    budgets: new BudgetGuard(redis, quiet),
    dispatcher: new Agent(),
    adapters: [new AnthropicAdapter(`http://127.0.0.1:${upstreamAddr.port}`)],
  });
  const gw = await app.listen({ port: 0, host: "127.0.0.1" });
  const call = (body: object, key: string = vkey, signal?: AbortSignal) =>
    fetch(`${gw}/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });

  assert.equal((await call({ model: "x" }, `tgk_${"A".repeat(43)}`)).status, 401);
  assert.equal((await call({ model: "x" }, "sk-ant-direct")).status, 401);
  assert.equal(seenBodies.length, 0);
  checks.ok("unknown / non-TokenGrid keys -> 401, nothing forwarded");

  // 4 streaming + 2 JSON; pretty-printed bodies prove byte-exact forwarding.
  const reqs = [true, true, false, true, false, true].map((stream, i) => ({
    model: "claude-opus-5-5",
    max_tokens: 100 + i,
    stream,
    messages: [{ role: "user", content: `case ${i}` }],
  }));
  for (const [i, r] of reqs.entries()) {
    const rawBody = JSON.stringify(r, null, i % 2 ? 3 : 0);
    const res: Response = await fetch(`${gw}/v1/messages`, { method: "POST", headers: { "x-api-key": vkey, "content-type": "application/json" }, body: rawBody });
    const got = Buffer.from(await res.arrayBuffer());
    assert.equal(res.status, 200);
    assert.ok(got.equals(sentBodies[sentBodies.length - 1] ?? Buffer.alloc(0)), `response ${i} byte-identical`);
    assert.equal(seenBodies[seenBodies.length - 1], rawBody, `request ${i} forwarded byte-identical`);
  }
  checks.ok("6 requests: request and response bytes forwarded unmodified (stream + JSON)");

  await sleep(50);
  assert.equal(redis.stream.length, 6);
  const events = redis.stream.map((p) => JSON.parse(p) as UsageEventV1);
  assert.ok(events.every((e) => e.usageComplete && e.providerRequestId.startsWith("req_")));
  assert.equal(one(events, "first event").usage.outputTokens, 777);
  assert.equal(events[2]?.usage.outputTokens, 50);
  checks.ok("6 usage events emitted with cumulative output tokens and provider request ids");

  const prices = new PriceCache(db);
  await prices.load();
  const payloads = [...redis.stream];
  const runAll = async () => {
    const tally: Record<string, number> = {};
    for (const [i, p] of payloads.entries()) {
      const o = await processEntry(db, prices, `0-${i + 1}`, p, 1, quiet);
      tally[o] = (tally[o] ?? 0) + 1;
    }
    return tally;
  };
  const rowCount = async () => one(await db.select({ n: count() }).from(schema.usageEvents), "row count").n;
  assert.deepEqual(await runAll(), { inserted: 6 });
  assert.equal(await rowCount(), 6);
  assert.deepEqual(await runAll(), { duplicate: 6 });
  assert.deepEqual(await runAll(), { duplicate: 6 });
  assert.equal(await rowCount(), 6);
  checks.ok("replaying the same 6 entries twice -> row count unchanged at 6");

  const first = one(events, "first event");
  const shifted = { ...first, occurredAt: new Date(Date.parse(first.occurredAt) + 3_600_000).toISOString() };
  assert.equal(await processEntry(db, prices, "0-99", JSON.stringify(shifted), 1, quiet), "duplicate");
  assert.equal(await rowCount(), 6);
  checks.ok("same provider request id with a different timestamp is still a duplicate (ledger)");

  const expected = events.reduce((a, e) => a + computeCost(e.usage, OPUS_55).totalPico, 0n);
  const { s } = one(await db.select({ s: dsql<string>`sum(cost_usd)::text` }).from(schema.usageEvents), "sum");
  assert.equal(s, formatDecimal(expected, COST_SCALE));
  const { stamped } = one(await db.select({ stamped: dsql<number>`count(distinct price_id)::int` }).from(schema.usageEvents), "stamped");
  assert.equal(stamped, 1);
  checks.ok(`stored sum $${s} equals independently computed cost exactly; price id stamped`);

  // Unknown model -> DLQ, then add price and redrive.
  await (await call({ model: "claude-future-9", max_tokens: 5, stream: true, messages: [] })).arrayBuffer();
  await sleep(50);
  const unknown = redis.stream[redis.stream.length - 1] ?? "";
  assert.equal(await processEntry(db, prices, "0-200", unknown, 1, quiet), "dead-lettered");
  assert.equal(one(await db.select().from(schema.usageDlq), "dlq row").errorName, "PriceNotFoundError");
  assert.equal(await rowCount(), 6);
  checks.ok("unknown model -> PriceNotFoundError in DLQ, no zero-cost row");

  const m = one(await db.insert(schema.models).values({ provider: "anthropic", providerModelId: "claude-future-9" }).returning(), "model");
  await db.insert(schema.modelPrices).values({ modelId: m.id, tier: "standard", effectiveFrom: new Date("2026-01-01T00:00:00Z"), ...OPUS_55, source: "integration test" });
  pnpm(["--filter", "@tokengrid/ingest", "redrive"], env);
  assert.equal((await db.select().from(schema.usageDlq).where(isNull(schema.usageDlq.resolvedAt))).length, 0);
  assert.equal(await rowCount(), 7);
  checks.ok("after adding the price row, redrive ingests the DLQ'd event");

  // A price change landing after the event does not re-price it.
  await db.insert(schema.modelPrices).values({ modelId: m.id, tier: "standard", effectiveFrom: new Date(), ...OPUS_55, inputPerMtok: "400", source: "integration test: later price" });
  const early = { ...(JSON.parse(unknown) as UsageEventV1), providerRequestId: "req_versioned", occurredAt: new Date(Date.now() - 60_000).toISOString() };
  await prices.load();
  await processEntry(db, prices, "0-300", JSON.stringify(early), 1, quiet);
  const v = one(await sql<{ c: string }[]>`select cost_usd::text as c from usage_events where provider_request_id = 'req_versioned'`, "versioned");
  assert.equal(v.c, computeCost(early.usage, OPUS_55).costUsd);
  checks.ok("event priced by the version in force at occurredAt, not the newer row");

  // Event outside any partition -> DLQ with the Postgres reason, not a crash loop.
  const opus = one(await sql<{ id: string }[]>`select id from models where provider_model_id = 'claude-opus-5-5'`, "opus");
  await db.insert(schema.modelPrices).values({
    modelId: opus.id,
    tier: "standard",
    effectiveFrom: new Date("2019-01-01T00:00:00Z"),
    effectiveTo: new Date("2026-09-25T00:00:00Z"),
    ...OPUS_55,
    source: "integration test: backfill",
  });
  await prices.load();
  const ancient = { ...first, providerRequestId: "req_ancient", occurredAt: "2020-01-01T00:00:00Z" };
  assert.equal(await processEntry(db, prices, "0-400", JSON.stringify(ancient), 1, quiet), "dead-lettered");
  const ad = one(await sql<{ error_message: string }[]>`select error_message from usage_dlq where stream_entry_id = '0-400'`, "dlq");
  assert.match(ad.error_message, /no partition/);
  checks.ok("event with no partition -> DLQ with the Postgres reason");

  // Client disconnect mid-stream: upstream aborted, partial usage flagged.
  const before = redis.stream.length;
  const ac = new AbortController();
  const res = await call({ model: "claude-opus-5-5", max_tokens: 5, stream: true, metadata: { user_id: "slow" }, messages: [] }, vkey, ac.signal);
  const body = res.body;
  assert.ok(body);
  const reader = body.getReader();
  let seen = "";
  while (!seen.includes("content_block_delta")) seen += new TextDecoder().decode((await reader.read()).value);
  ac.abort();
  await sleep(300);
  assert.ok(upstreamAborted, "upstream request aborted");
  assert.equal(redis.stream.length, before + 1);
  const partial = JSON.parse(redis.stream[redis.stream.length - 1] ?? "{}") as UsageEventV1;
  assert.equal(partial.usageComplete, false);
  assert.ok(partial.usage.inputTokens > 0);
  checks.ok("client disconnect aborts upstream; event emitted with usageComplete=false");

  // Redis down: emit buffers, never throws, flushes on recovery.
  redis.xaddFails = true;
  const buffered = new UsageEmitter(redis.asRedis(), quiet);
  buffered.emit(first);
  await sleep(20);
  assert.equal(buffered.pendingCount, 1);
  redis.xaddFails = false;
  const n0 = redis.stream.length;
  await buffered.close();
  assert.equal(buffered.pendingCount, 0);
  assert.equal(redis.stream.length, n0 + 1);
  checks.ok("emit during Redis outage buffers, flushes on recovery, never throws");

  await app.close();
  upstream.close();
  await emitter.close();
  await sql.end();
} finally {
  await pg.stop();
  console.log(`\nstage 1: ${checks.passed} checks passed`);
}
