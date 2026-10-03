/**
 * Stage 3 acceptance: retry detection, waste attribution, prompt lint and the
 * efficiency score, driven through the real gateway against a fake upstream.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { Agent } from "undici";
import { createDb } from "@tokengrid/db";
import { BudgetGuard } from "../../../apps/gateway/src/budget.js";
import { AnthropicAdapter } from "../../../apps/gateway/src/providers/anthropic.js";
import { VirtualKeyResolver } from "../../../apps/gateway/src/auth.js";
import { UsageEmitter } from "../../../apps/gateway/src/emit.js";
import { createApp, registerRoutes } from "../../../apps/gateway/src/server.js";
import { storeScore } from "../../../apps/ingest/src/efficiency.js";
import { processEntry } from "../../../apps/ingest/src/process.js";
import { PriceCache } from "../../../apps/ingest/src/prices.js";
import { getUsage } from "../../../apps/web/src/lib/usage.js";
import { Checks, FakeRedis, one, pnpm, seededKeys, sleep, startPostgres, testEnv } from "./harness.js";

const quiet = { warn: () => {}, error: () => {} };
const pg = await startPostgres();
const env = testEnv(pg.url);
const secret = env.TOKENGRID_SESSION_SECRET ?? "";
const checks = new Checks();

try {
  pnpm(["db:migrate"], env);
  const keys = seededKeys(pnpm(["db:seed"], env));
  const keyA = keys["a@tokengrid.local"];
  const keyC = keys["c@tokengrid.local"];
  assert.ok(keyA && keyC);
  const { db, sql } = createDb();

  // Fake upstream: bills ~1 input token per 4 request characters, like real English text.
  let n = 0;
  const upstream = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      const body = JSON.parse(raw.toString()) as { model: string };
      res.writeHead(200, { "content-type": "application/json", "request-id": `req_${++n}` });
      res.end(JSON.stringify({ id: `msg_${n}`, type: "message", model: body.model, stop_reason: "end_turn", usage: { input_tokens: Math.ceil(raw.length / 4), output_tokens: 180 } }));
    });
  });
  await new Promise<void>((r) => upstream.listen(0, r));
  const addr = upstream.address();
  assert.ok(addr && typeof addr === "object");

  const redis = new FakeRedis();
  const app = createApp({ logger: false });
  registerRoutes(app, {
    resolver: new VirtualKeyResolver(redis.asRedis(), db, quiet),
    emitter: new UsageEmitter(redis.asRedis(), quiet),
    budgets: new BudgetGuard(redis, quiet),
    dispatcher: new Agent(),
    adapters: [new AnthropicAdapter(`http://127.0.0.1:${addr.port}`)],
  });
  const gw = await app.listen({ port: 0, host: "127.0.0.1" });
  const send = async (key: string, body: object, session?: string) => {
    const res = await fetch(`${gw}/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": key, "content-type": "application/json", ...(session ? { "x-tokengrid-session": session } : {}) },
      body: JSON.stringify(body),
    });
    assert.equal(res.status, 200);
    await res.arrayBuffer();
  };
  const prices = new PriceCache(db);
  await prices.load();
  const drain = async () => {
    await sleep(30);
    for (let p = redis.stream.shift(); p !== undefined; p = redis.stream.shift()) {
      assert.notEqual(await processEntry(db, prices, `e-${randomBytes(4).toString("hex")}`, p, 1, { warn: (o: object, m: string) => console.warn(m, o) }), "dead-lettered");
    }
  };
  const users = await sql<{ id: string; org_id: string; email: string }[]>`select id, org_id, email from users`;
  const user = (email: string) => {
    const u = users.find((x) => x.email === email);
    assert.ok(u);
    return u;
  };

  // ---- retries ----
  const prompt = (text: string) => ({
    model: "claude-sonnet-5-5",
    max_tokens: 400,
    system: "You are a terse assistant for substation operators.",
    messages: [{ role: "user", content: text }],
  });
  const question = "Which feeder on the north bus tripped first during last night's overload, and why?";
  await send(keyA, prompt(question), "chat-1");
  await drain();
  const a = user("a@tokengrid.local");
  const before = await storeScore(db, a.id, a.org_id, new Date());

  await send(keyA, prompt(question), "chat-1");
  await send(keyA, prompt(`${question} `), "chat-1"); // a trailing space is still the same prompt
  await send(keyA, prompt("Draft a shift handover note for the morning crew."), "chat-1");
  await send(keyA, prompt(question), "chat-2"); // same words, different conversation
  await drain();

  const retries = await sql<{ discarded_request_id: string; retry_request_id: string; wasted: string; hour_ok: boolean }[]>`
    select r.discarded_request_id, r.retry_request_id, r.wasted_cost_usd::text as wasted,
           date_trunc('hour', r.discarded_at) = date_trunc('hour', e.occurred_at) as hour_ok
    from retries r join usage_events e on e.provider_request_id = r.discarded_request_id
    order by r.discarded_at`;
  assert.deepEqual(
    retries.map((r) => [r.discarded_request_id, r.retry_request_id]),
    [
      ["req_1", "req_2"],
      ["req_2", "req_3"],
    ],
  );
  assert.ok(retries.every((r) => r.hour_ok));
  checks.ok("same prompt 3x in a session: 2 retries (req_1, req_2 discarded); a different question and another session are not retries");

  const wasted = one(await sql<{ v: string }[]>`select sum(wasted_cost_usd)::text as v from usage_rollup_hourly`, "rollup").v;
  const expectedWaste = one(await sql<{ v: string }[]>`select sum(cost_usd)::text as v from usage_events where provider_request_id in ('req_1','req_2')`, "events").v;
  assert.equal(wasted, expectedWaste);
  checks.ok(`waste attributed to the discarded requests' hours in the rollup: $${wasted}`);

  const after = await storeScore(db, a.id, a.org_id, new Date());
  assert.ok(before.score !== null && after.score !== null && after.score < before.score);
  assert.equal(after.acceptanceRate, null);
  assert.equal(after.weights.acceptance, 0);
  checks.ok(`score drops ${before.score} -> ${after.score}; acceptance has no signal and carries no weight`);

  const aView = await getUsage(db, { userId: a.id, orgId: a.org_id }, { view: "self", period: "7d" }, secret);
  assert.equal(aView.split.wastedUsd, wasted);
  assert.equal(aView.totals.retriedRequests, 2);
  assert.ok(aView.score?.components.find((c) => c.key === "acceptance")?.value === null);
  checks.ok("dashboard self view: wasted segment, re-sent count and score components");

  // ---- lint: 40k-char uncached prefix, 30 times ----
  const prefix = "Feeder load log, north substation. Each line records feeder id, timestamp and amps. ".repeat(470).slice(0, 40_000);
  for (let i = 0; i < 30; i++) {
    await send(keyC, {
      model: "claude-opus-5-5",
      max_tokens: 2000,
      system: prefix,
      messages: [{ role: "user", content: `Question ${i}: summarise feeder ${(i * 7) % 23} in ${["one", "two", "three"][i % 3]} sentences.` }],
    });
  }
  await drain();
  const c = user("c@tokengrid.local");
  const finding = one(
    await sql<{ savings: string; at_stake: string; requests_7d: number; detail: { prefixTokens: number } }[]>`
      select monthly_savings_usd::text as savings, monthly_at_stake_usd::text as at_stake, requests_7d, detail
      from lint_findings where user_id = ${c.id} and rule = 'uncached_prefix'`,
    "uncached_prefix finding",
  );
  // ~10k prefix tokens x (4.00 - 0.20) $/MTok x 30 requests/week x 30/7, minus one cache write.
  assert.equal(finding.requests_7d, 30);
  assert.ok(finding.detail.prefixTokens > 9_000 && finding.detail.prefixTokens < 11_000, `prefix tokens ${finding.detail.prefixTokens}`);
  const savings = Number(finding.savings);
  assert.ok(savings > 4 && savings < 6, `savings ${savings}`);
  assert.equal((await sql`select 1 from retries where user_id = ${c.id}`).length, 0, "30 different questions are not retries");
  checks.ok(`40k-char uncached prefix x30: finding with ~${finding.detail.prefixTokens} prefix tokens, $${savings.toFixed(2)}/month saved if cached ($${Number(finding.at_stake).toFixed(2)}/month at stake)`);

  const cScore = await storeScore(db, c.id, c.org_id, new Date());
  assert.ok(cScore.cacheHitRate === 0 && cScore.weights.cache > 0);
  checks.ok(`cache component measured for the prefix user (hit rate 0%, weight ${(cScore.weights.cache * 100).toFixed(0)}%), score ${cScore.score}`);

  const manager = user("manager@tokengrid.local");
  const team = one(await sql<{ id: string }[]>`select id from teams`, "team");
  const teamView = await getUsage(db, { userId: manager.id, orgId: manager.org_id }, { view: "team", period: "7d", teamId: team.id }, secret);
  const teamPrefix = teamView.teamFindings.find((t) => t.rule === "uncached_prefix");
  assert.ok(teamPrefix);
  assert.equal(teamPrefix.people, null, "one person is below the anonymity threshold");
  assert.equal(teamView.findings.length, 0);
  assert.equal(teamView.score, null);
  checks.ok("team view: findings totalled per habit, head count hidden below 3 people, no per-person findings or scores");

  // ---- no prompt text stored anywhere ----
  const dump = JSON.stringify(
    await sql`select row_to_json(t) from (
      select * from prompt_features) t
      union all select row_to_json(t) from (select * from lint_findings) t
      union all select row_to_json(t) from (select * from usage_events) t`,
  );
  for (const word of ["feeder", "Feeder", "substation", "handover"]) assert.ok(!dump.includes(word), `"${word}" leaked into storage`);
  checks.ok("no prompt text in prompt_features, lint_findings or usage_events");

  await app.close();
  upstream.close();
  await sql.end();
} finally {
  await pg.stop();
  console.log(`\nstage 3: ${checks.passed} checks passed`);
}
