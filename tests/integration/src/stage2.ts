/**
 * Stage 2 acceptance: budgets at the gateway, tenancy and the consent/audit
 * rules behind /api/usage, and the built Next server. Real Postgres 16;
 * Redis is the in-memory fake from the harness.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { Agent } from "undici";
import { createDb, schema, type Database } from "@tokengrid/db";
import { BudgetGuard } from "../../../apps/gateway/src/budget.js";
import { VirtualKeyResolver } from "../../../apps/gateway/src/auth.js";
import { UsageEmitter } from "../../../apps/gateway/src/emit.js";
import { createApp, registerRoutes } from "../../../apps/gateway/src/server.js";
import { processEntry } from "../../../apps/ingest/src/process.js";
import { PriceCache } from "../../../apps/ingest/src/prices.js";
import { SpendCounters } from "../../../apps/ingest/src/spend.js";
import { signSession, type Session } from "../../../apps/web/src/lib/session-token.js";
import { getUsage, setConsent, UsageAccessError } from "../../../apps/web/src/lib/usage.js";
import type { MeterRow } from "../../../apps/web/src/lib/usage-types.js";
import { Checks, FakeRedis, one, pnpm, seededKeys, sleep, startNext, startPostgres, testEnv } from "./harness.js";

const quiet = { warn: () => {}, error: () => {} };
const NAMES = ["Demo Member A", "Demo Member B", "Demo Member C", "Demo Manager", "Demo Admin"];
const leaks = (json: string, allowed: string[]) => NAMES.filter((n) => !allowed.includes(n) && json.includes(n));

const pg = await startPostgres();
const env = testEnv(pg.url);
const secret = env.TOKENGRID_SESSION_SECRET ?? "";
const checks = new Checks();
let stopNext: (() => void) | undefined;

try {
  pnpm(["db:migrate"], env);
  const keys = seededKeys(pnpm(["db:seed"], env));
  const key = (email: string) => {
    const k = keys[email];
    assert.ok(k, `seed key for ${email}`);
    return k;
  };
  pnpm(["db:seed"], env);
  checks.ok("migrate + seed (twice): admin, manager, members A/B/C, one team, consent for A only");

  const { db, sql } = createDb();

  // ---- price guards ----
  const opus = one(await sql<{ id: string }[]>`select id from models where provider_model_id = 'claude-opus-5-5'`, "opus");
  const insertPrice = (from: string) => sql`
    insert into model_prices (model_id, tier, effective_from, input_per_mtok, output_per_mtok,
      cache_read_per_mtok, cache_write_5m_per_mtok, cache_write_1h_per_mtok, source)
    values (${opus.id}, 'fast', ${from}::timestamptz, 8, 40, 0.4, 10, 16, 'integration test')`;
  await assert.rejects(insertPrice(new Date().toISOString()), /at least 2 minutes in the future/);
  await assert.rejects(sql`update model_prices set input_per_mtok = 0 where model_id = ${opus.id}`, /append-only/);
  await assert.rejects(sql`delete from model_prices where model_id = ${opus.id}`, /append-only/);
  await insertPrice(new Date(Date.now() + 86_400_000).toISOString());
  checks.ok("price rows: backdated insert, in-place edit and delete refused; future-dated insert allowed");

  // ---- gateway with budgets ----
  let n = 0;
  const upstream = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      // 20,000 output tokens on Opus 5.5 = $0.40 per call.
      const body = JSON.stringify({ id: `msg_${++n}`, type: "message", model: "claude-opus-5-5", stop_reason: "end_turn", usage: { input_tokens: 0, output_tokens: 20_000 } });
      res.writeHead(200, { "content-type": "application/json", "request-id": `req_${n}` });
      res.end(body);
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
    anthropicUpstreamUrl: `http://127.0.0.1:${addr.port}`,
  });
  const gw = await app.listen({ port: 0, host: "127.0.0.1" });
  const call = async (k: string) => {
    const res = await fetch(`${gw}/v1/messages`, { method: "POST", headers: { "x-api-key": k, "content-type": "application/json" }, body: "{}" });
    const text = await res.text();
    return { status: res.status, warning: res.headers.get("x-tokengrid-budget-warning"), text };
  };

  pnpm(["--filter", "@tokengrid/ingest", "budget", "set", "--scope", "user", "--email", "b@tokengrid.local", "--limit", "1.00"], env);
  const counters = new SpendCounters(redis);
  await counters.syncBudgets(db);
  const prices = new PriceCache(db);
  await prices.load();
  const drain = async () => {
    await sleep(20);
    for (let p = redis.stream.shift(); p !== undefined; p = redis.stream.shift()) {
      await processEntry(db, prices, `e-${randomBytes(4).toString("hex")}`, p, 1, quiet, counters);
    }
  };

  const b = key("b@tokengrid.local");
  const r1 = await call(b);
  await drain();
  assert.equal(r1.warning, null);
  await call(b);
  await drain();
  const r3 = await call(b);
  await drain();
  assert.match(r3.warning ?? "", /scope=user; used=80%; spent=\$0\.80; limit=\$1\.00/);
  checks.ok(`80% warning header: "${r3.warning}"`);

  const r4 = await call(b);
  assert.equal(r4.status, 402);
  const err = JSON.parse(r4.text) as { error: { type: string; message: string } };
  assert.equal(err.error.type, "billing_error");
  assert.match(err.error.message, /monthly limit \$1\.00, spent \$1\.20/);
  assert.equal(n, 3, "the refused call never reached upstream");
  checks.ok(`$1 cap: 4th call refused with 402 before forwarding: "${err.error.message}"`);

  assert.equal((await call(key("a@tokengrid.local"))).status, 200);
  checks.ok("another user without a budget is unaffected");

  for (const k of [...redis.kv.keys()]) if (k.startsWith("tg:spend:")) redis.kv.delete(k);
  assert.equal((await call(b)).status, 200, "fails open while counters are missing");
  await drain();
  await counters.syncFromRollups(db);
  assert.equal((await call(b)).status, 402);
  checks.ok("spend counters wiped -> rebuilt from rollups -> cap enforced again");

  for (const email of ["a@tokengrid.local", "c@tokengrid.local", "manager@tokengrid.local", "a@tokengrid.local"]) await call(key(email));
  await drain();
  const ev = one(await sql<{ v: string }[]>`select sum(cost_usd)::text as v from usage_events`, "events").v;
  const ro = one(await sql<{ v: string }[]>`select sum(cost_usd)::text as v from usage_rollup_hourly`, "rollups").v;
  assert.equal(ev, ro);
  checks.ok(`rollups equal raw events exactly ($${ro})`);

  // ---- access rules ----
  const people = await sql<{ id: string; org_id: string; email: string }[]>`select id, org_id, email from users`;
  const session = (email: string): Session => {
    const p = people.find((x) => x.email === email);
    assert.ok(p, email);
    return { userId: p.id, orgId: p.org_id };
  };
  const team = one(await sql<{ id: string }[]>`select id from teams`, "team");
  const auditCount = async (action: string) => one(await sql<{ c: number }[]>`select count(*)::int as c from audit_log where action = ${action}`, "audit").c;
  const isAccess = (status: number, code?: string) => (e: unknown) => e instanceof UsageAccessError && e.status === status && (!code || e.code === code);

  const bSelf = await getUsage(db, session("b@tokengrid.local"), { view: "self", period: "30d" }, secret);
  assert.deepEqual(leaks(JSON.stringify(bSelf), ["Demo Member B"]), []);
  assert.equal(bSelf.budget?.limitUsd, "1.00");
  await assert.rejects(getUsage(db, session("b@tokengrid.local"), { view: "team", period: "30d", teamId: team.id }, secret), isAccess(403));
  checks.ok("member B: sees only own data (no other names anywhere in the response); team view 403");

  const mgr = session("manager@tokengrid.local");
  const mTeam = await getUsage(db, mgr, { view: "team", period: "30d", teamId: team.id }, secret);
  assert.deepEqual(leaks(JSON.stringify(mTeam), ["Demo Manager"]), []);
  assert.deepEqual(mTeam.rows.map((r) => r.label), ["You", "Member 01", "Member 02", "Member 03"]);
  const others = mTeam.rows.filter((r) => !r.isViewer);
  assert.equal(others.filter((r) => r.drilldownAllowed).length, 1);
  assert.equal(await auditCount("usage.team_view"), 1);
  checks.ok("manager team view: aggregate + unnamed rows, one drill-down-able (A), view audited");

  const sumRows = mTeam.rows.reduce((a, r) => a + Number(r.figures.costUsd), 0);
  assert.ok(Math.abs(sumRows - Number(mTeam.totals.costUsd)) < 1e-9);
  checks.ok("team aggregate equals the sum of member lines");

  const consentRow: MeterRow = one(others.filter((r) => r.drilldownAllowed), "consenting row");
  const privateRow: MeterRow = one(others.filter((r) => !r.drilldownAllowed), "private row");
  const drill = (ref: string, database: Database = db) => getUsage(database, mgr, { view: "member", period: "30d", teamId: team.id, ref }, secret);

  // The audit row must be written before any data is read: fail the audit insert and confirm nothing comes back.
  const failingAudit = new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === "insert") {
        return (table: Parameters<Database["insert"]>[0]) => {
          if (table === schema.auditLog) throw new Error("audit store down");
          return target.insert(table);
        };
      }
      return Reflect.get(target, prop, receiver) as unknown;
    },
  });
  await assert.rejects(drill(consentRow.ref, failingAudit), /audit store down/);
  checks.ok("drill-down with a failing audit write returns no data");

  const before = await auditCount("usage.drilldown");
  const opened = await drill(consentRow.ref);
  assert.equal(opened.scope.kind === "member" ? opened.scope.displayName : "", "Demo Member A");
  assert.equal(await auditCount("usage.drilldown"), before + 1);
  const audit = one(await sql<{ email: string }[]>`select u.email from audit_log a join users u on u.id = a.subject_user_id where a.action = 'usage.drilldown'`, "audit");
  assert.equal(audit.email, "a@tokengrid.local");
  checks.ok("manager drill-down into consenting A: named data returned, audit row (subject A) written");

  await assert.rejects(drill(privateRow.ref), isAccess(403, "no_consent"));
  assert.equal(await auditCount("usage.drilldown"), before + 1);
  checks.ok("drill-down into a non-consenting member: 403 no_consent, nothing recorded as viewed");

  const aSelf = await getUsage(db, session("a@tokengrid.local"), { view: "self", period: "30d" }, secret);
  assert.equal(aSelf.viewer.recentViews[0]?.actor, "Demo Manager");
  checks.ok("member A sees that Demo Manager opened their usage");

  await setConsent(db, session("a@tokengrid.local"), false);
  await assert.rejects(drill(consentRow.ref), isAccess(403, "no_consent"));
  checks.ok("A revokes consent -> drill-down refused immediately");

  // ---- the built Next server ----
  const next = await startNext(env);
  stopNext = next.stop;
  const cookie = (email: string) => `tg_session=${signSession(session(email), secret)}`;
  const api = (q: string, c?: string) => fetch(`${next.url}/api/usage?${q}`, c ? { headers: { cookie: c } } : {});
  assert.equal((await api("view=self")).status, 401);
  const bHttp = await api("view=self&period=month", cookie("b@tokengrid.local"));
  assert.equal(bHttp.status, 200);
  assert.deepEqual(leaks(await bHttp.text(), ["Demo Member B"]), []);
  assert.equal((await api(`view=team&team=${team.id}`, cookie("b@tokengrid.local"))).status, 403);
  assert.equal((await api("view=self", cookie("b@tokengrid.local").replace(/.$/, "x"))).status, 401);
  const devLogin = await fetch(`${next.url}/api/session`, { method: "POST", body: new URLSearchParams({ email: "b@tokengrid.local" }), redirect: "manual" });
  assert.equal(devLogin.status, 404);
  assert.equal((await fetch(`${next.url}/usage`, { headers: { cookie: cookie("manager@tokengrid.local") } })).status, 200);
  checks.ok("built Next server: 401 without session or with a forged cookie, member 403 on team, dev login refused in production, /usage renders");

  await app.close();
  upstream.close();
  await sql.end();
} finally {
  stopNext?.();
  await pg.stop();
  console.log(`\nstage 2: ${checks.passed} checks passed`);
}
