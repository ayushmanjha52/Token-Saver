/**
 * Stage 4 acceptance: an OpenAI adapter behind the same ProviderAdapter
 * interface as Anthropic, with identical downstream behaviour.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { Agent } from "undici";
import { createDb } from "@tokengrid/db";
import { computeCost } from "@tokengrid/shared";
import { BudgetGuard } from "../../../apps/gateway/src/budget.js";
import { VirtualKeyResolver } from "../../../apps/gateway/src/auth.js";
import { UsageEmitter } from "../../../apps/gateway/src/emit.js";
import { AnthropicAdapter } from "../../../apps/gateway/src/providers/anthropic.js";
import { OpenAIAdapter } from "../../../apps/gateway/src/providers/openai.js";
import { createApp, registerRoutes } from "../../../apps/gateway/src/server.js";
import { storeScore } from "../../../apps/ingest/src/efficiency.js";
import { processEntry } from "../../../apps/ingest/src/process.js";
import { PriceCache } from "../../../apps/ingest/src/prices.js";
import { getUsage } from "../../../apps/web/src/lib/usage.js";
import { Checks, FakeRedis, one, pnpm, REPO, seededKeys, sleep, startPostgres, testEnv } from "./harness.js";

const quiet = { warn: () => {}, error: () => {} };
const GPT_6_SOL = { inputPerMtok: "2.00", outputPerMtok: "10.00", cacheReadPerMtok: "0.20", cacheWrite5mPerMtok: "2.50", cacheWrite1hPerMtok: "2.50" };
const checks = new Checks();

// ---- boundary: nothing outside src/providers/ branches on provider ----
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === "providers" || name === "node_modules" || name === ".next" ? [] : sourceFiles(p);
    return /\.(ts|tsx)$/.test(name) && !name.endsWith(".test.ts") ? [p] : [];
  });
}
const branching = /(===|!==|case)\s*["'](anthropic|openai)["']|["'](anthropic|openai)["']\s*(===|!==)/;
const offenders = ["apps/gateway/src", "apps/ingest/src", "apps/web/src"]
  .flatMap((d) => sourceFiles(join(REPO, d)))
  .filter((f) => branching.test(readFileSync(f, "utf8")));
assert.deepEqual(offenders, []);
checks.ok("no code outside providers/ compares against a provider name");

const pg = await startPostgres();
const env = testEnv(pg.url);
env.SEED_OPENAI_API_KEY = "sk-openai-fake";
const secret = env.TOKENGRID_SESSION_SECRET ?? "";

try {
  pnpm(["db:migrate"], env);
  const keys = seededKeys(pnpm(["db:seed"], env));
  const keyB = keys["b@tokengrid.local"];
  const keyC = keys["c@tokengrid.local"];
  assert.ok(keyB && keyC);
  const { db, sql } = createDb();

  // ---- fake OpenAI ----
  let n = 0;
  const seenBodies: string[] = [];
  const openai = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      if (req.url === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ object: "list", data: [{ id: "gpt-6-sol", object: "model" }] }));
        return;
      }
      assert.equal(req.headers.authorization, "Bearer sk-openai-fake");
      const raw = Buffer.concat(chunks).toString();
      seenBodies.push(raw);
      const body = JSON.parse(raw) as { model: string; stream?: boolean; stream_options?: { include_usage?: boolean }; messages: { content: string }[] };
      const prompt = Math.ceil(raw.length / 4);
      // A long instruction prefix is "cached" from the second time it is seen.
      const prefixed = (body.messages[0]?.content.length ?? 0) > 20_000;
      const cached = prefixed && seenBodies.filter((b) => b.length > 20_000).length > 1 ? Math.floor(prompt * 0.75) : 0;
      const usage = { prompt_tokens: prompt, completion_tokens: 150, total_tokens: prompt + 150, prompt_tokens_details: { cached_tokens: cached, cache_write_tokens: 0 } };
      const id = `chatcmpl-${++n}`;
      const model = `${body.model}-2026-08-01`;
      if (!body.stream) {
        res.writeHead(200, { "content-type": "application/json", "x-request-id": `oai_${n}` });
        res.end(JSON.stringify({ id, object: "chat.completion", model, choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream", "x-request-id": `oai_${n}` });
      const chunk = (o: object) => `data: ${JSON.stringify({ id, object: "chat.completion.chunk", model, ...o })}\n\n`;
      res.write(chunk({ choices: [{ index: 0, delta: { content: "Hel" }, finish_reason: null }] }));
      res.write(chunk({ choices: [{ index: 0, delta: { content: "lo" }, finish_reason: "stop" }] }));
      // Real OpenAI behaviour: usage only exists if the request asked for it.
      if (body.stream_options?.include_usage) res.write(chunk({ choices: [], usage }));
      res.end("data: [DONE]\n\n");
    });
  });
  // ---- fake Anthropic (same usage shape as stage 3) ----
  let m = 0;
  const anthropic = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      const body = JSON.parse(raw.toString()) as { model: string };
      res.writeHead(200, { "content-type": "application/json", "request-id": `ant_${++m}` });
      res.end(JSON.stringify({ id: `msg_${m}`, type: "message", model: body.model, stop_reason: "end_turn", usage: { input_tokens: Math.ceil(raw.length / 4), output_tokens: 150 } }));
    });
  });
  await Promise.all([new Promise<void>((r) => openai.listen(0, r)), new Promise<void>((r) => anthropic.listen(0, r))]);
  const port = (s: typeof openai) => {
    const a = s.address();
    assert.ok(a && typeof a === "object");
    return a.port;
  };

  const redis = new FakeRedis();
  const app = createApp({ logger: false });
  registerRoutes(app, {
    resolver: new VirtualKeyResolver(redis.asRedis(), db, quiet),
    emitter: new UsageEmitter(redis.asRedis(), quiet),
    budgets: new BudgetGuard(redis, quiet),
    dispatcher: new Agent(),
    adapters: [new AnthropicAdapter(`http://127.0.0.1:${port(anthropic)}`), new OpenAIAdapter(`http://127.0.0.1:${port(openai)}`)],
  });
  const gw = await app.listen({ port: 0, host: "127.0.0.1" });
  const prices = new PriceCache(db);
  await prices.load();
  const drain = async () => {
    await sleep(30);
    for (let p = redis.stream.shift(); p !== undefined; p = redis.stream.shift()) {
      assert.equal(await processEntry(db, prices, `e-${randomBytes(4).toString("hex")}`, p, 1, quiet), "inserted");
    }
  };
  const chat = (key: string, body: object, raw?: string) =>
    fetch(`${gw}/openai/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "x-tokengrid-session": "s" },
      body: raw ?? JSON.stringify(body),
    });

  // 1. Streaming: include_usage injected, usage metered.
  const streamRes = await chat(keyB, { model: "gpt-6-sol", stream: true, messages: [{ role: "user", content: "Say hello." }] });
  const streamText = await streamRes.text();
  assert.equal(streamRes.status, 200);
  assert.ok(streamText.includes('"usage"') && streamText.endsWith("data: [DONE]\n\n"));
  assert.equal((JSON.parse(seenBodies[0] ?? "{}") as { stream_options?: { include_usage?: boolean } }).stream_options?.include_usage, true);
  await drain();
  const streamed = one(await sql<{ input_tokens: number; output_tokens: number; cost: string; model: string }[]>`
    select input_tokens, output_tokens, cost_usd::text as cost, model from usage_events where provider = 'openai'`, "openai event");
  assert.ok(streamed.input_tokens > 0 && streamed.output_tokens === 150 && Number(streamed.cost) > 0);
  assert.equal(streamed.model, "gpt-6-sol", "snapshot suffix stripped for pricing");
  checks.ok(`streaming OpenAI request: include_usage injected, usage metered (${streamed.input_tokens} in / ${streamed.output_tokens} out, $${streamed.cost})`);

  // 2. Non-streaming bodies are forwarded byte for byte.
  const rawBody = '{"model":"gpt-6-sol",   "messages":[{"role":"user","content":"Byte exact?"}]}';
  assert.equal((await chat(keyB, {}, rawBody)).status, 200);
  assert.equal(seenBodies[seenBodies.length - 1], rawBody);
  checks.ok("non-streaming request body forwarded byte for byte");

  // 3. Cached prefix: no double-counted input.
  const prefix = "Standing instructions for feeder triage. ".repeat(700);
  for (const q of ["Triage feeder 4.", "Triage feeder 9."]) {
    await (await chat(keyB, { model: "gpt-6-sol", messages: [{ role: "system", content: prefix }, { role: "user", content: q }] })).arrayBuffer();
  }
  await drain();
  const cachedRow = one(
    await sql<{ input_tokens: number; cache_read_tokens: number; output_tokens: number; cost: string }[]>`
      select input_tokens, cache_read_tokens, output_tokens, cost_usd::text as cost from usage_events
      where provider = 'openai' and cache_read_tokens > 0`,
    "cached openai event",
  );
  const promptTotal = cachedRow.input_tokens + cachedRow.cache_read_tokens;
  const expected = computeCost(
    { inputTokens: cachedRow.input_tokens, outputTokens: cachedRow.output_tokens, cacheReadTokens: cachedRow.cache_read_tokens, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0 },
    GPT_6_SOL,
  ).costUsd;
  const naive = computeCost({ inputTokens: promptTotal, outputTokens: cachedRow.output_tokens, cacheReadTokens: cachedRow.cache_read_tokens, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0 }, GPT_6_SOL).costUsd;
  assert.equal(cachedRow.cost, expected);
  assert.ok(Number(naive) > Number(cachedRow.cost));
  checks.ok(`cached prefix: ${cachedRow.cache_read_tokens} cached tokens subtracted from ${promptTotal} prompt tokens; $${cachedRow.cost} (double-counting would be $${naive})`);

  // 4. Provider-shaped errors and pass-through routes.
  const bad = await fetch(`${gw}/openai/v1/chat/completions`, { method: "POST", headers: { authorization: `Bearer tgk_${"A".repeat(43)}`, "content-type": "application/json" }, body: "{}" });
  assert.equal(bad.status, 401);
  assert.equal(((await bad.json()) as { error: { code: string } }).error.code, "invalid_api_key");
  const models = await fetch(`${gw}/openai/v1/models`, { headers: { authorization: `Bearer ${keyB}` } });
  assert.equal(models.status, 200);
  assert.equal(redis.stream.length, 0, "model listing is not metered");
  checks.ok("OpenAI-shaped 401, /openai/v1/models passes through unmetered");

  // 5. Identical downstream behaviour: the same retry scenario through each provider.
  const sameQuestion = "Which breaker on the east bus opened first?";
  for (let i = 0; i < 3; i++) {
    await (await chat(keyB, { model: "gpt-6-sol", messages: [{ role: "user", content: sameQuestion }] })).arrayBuffer();
    await (
      await fetch(`${gw}/anthropic/v1/messages`, {
        method: "POST",
        headers: { "x-api-key": keyC, "content-type": "application/json", "x-tokengrid-session": "s" },
        body: JSON.stringify({ model: "claude-sonnet-5-5", max_tokens: 100, messages: [{ role: "user", content: sameQuestion }] }),
      })
    ).arrayBuffer();
  }
  await drain();
  const users = await sql<{ id: string; org_id: string; email: string }[]>`select id, org_id, email from users`;
  const views = [];
  for (const email of ["b@tokengrid.local", "c@tokengrid.local"]) {
    const u = users.find((x) => x.email === email);
    assert.ok(u);
    await storeScore(db, u.id, u.org_id, new Date());
    views.push(await getUsage(db, { userId: u.id, orgId: u.org_id }, { view: "self", period: "7d" }, secret));
  }
  const [viaOpenAI, viaAnthropic] = views;
  assert.ok(viaOpenAI && viaAnthropic);
  assert.equal(viaOpenAI.totals.retriedRequests, 2);
  assert.equal(viaAnthropic.totals.retriedRequests, 2);
  assert.ok(Number(viaOpenAI.split.wastedUsd) > 0 && Number(viaAnthropic.split.wastedUsd) > 0);
  assert.deepEqual(Object.keys(viaOpenAI).sort(), Object.keys(viaAnthropic).sort());
  assert.deepEqual(
    viaOpenAI.score?.components.map((c) => c.key),
    viaAnthropic.score?.components.map((c) => c.key),
  );
  checks.ok(`identical dashboard behaviour: 2 retries and waste via each provider (OpenAI $${viaOpenAI.split.wastedUsd}, Anthropic $${viaAnthropic.split.wastedUsd})`);

  await app.close();
  openai.close();
  anthropic.close();
  await sql.end();
} finally {
  await pg.stop();
  console.log(`\nstage 4: ${checks.passed} checks passed`);
}
