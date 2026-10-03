/**
 * Stage 5 acceptance: reconciliation catches a deliberate 5% metering bug
 * and names the model; retention, export and delete-on-request.
 */
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { Agent } from "undici";
import { applyRetention, CATALOG, createDb, exportUserData } from "@tokengrid/db";
import { computeCost, type NormalizedUsage } from "@tokengrid/shared";
import { BudgetGuard } from "../../../apps/gateway/src/budget.js";
import { VirtualKeyResolver } from "../../../apps/gateway/src/auth.js";
import { UsageEmitter } from "../../../apps/gateway/src/emit.js";
import { AnthropicAdapter } from "../../../apps/gateway/src/providers/anthropic.js";
import type { UsageMeter } from "../../../apps/gateway/src/providers/types.js";
import { createApp, registerRoutes } from "../../../apps/gateway/src/server.js";
import { processEntry } from "../../../apps/ingest/src/process.js";
import { PriceCache } from "../../../apps/ingest/src/prices.js";
import { getReconciliation } from "../../../apps/web/src/lib/admin.js";
import { signSession } from "../../../apps/web/src/lib/session-token.js";
import { Checks, FakeRedis, one, pnpm, REPO, seededKeys, sleep, startNext, startPostgres, testEnv } from "./harness.js";

const quiet = { warn: () => {}, error: () => {} };
const BUGGY_MODEL = "claude-sonnet-5-5";
const ADMIN_KEY = "sk-ant-admin-fake";
const WORKSPACE = "wrkspc_gateway";

/** The deliberate bug: this adapter under-meters one model by exactly 5%. */
class FivePercentShortAdapter extends AnthropicAdapter {
  override createMeter(contentType: string): UsageMeter {
    const inner = super.createMeter(contentType);
    return {
      streamed: inner.streamed,
      push: (c) => inner.push(c),
      end: () => inner.end(),
      result: (id) => {
        const r = inner.result(id);
        if (!r || r.model !== BUGGY_MODEL) return r;
        const scale = (n: number) => Math.round(n * 0.95);
        const u = r.usage;
        return { ...r, usage: { inputTokens: scale(u.inputTokens), outputTokens: scale(u.outputTokens), cacheReadTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0 } };
      },
    };
  }
}

const pg = await startPostgres();
const env = testEnv(pg.url);
const secret = env.TOKENGRID_SESSION_SECRET ?? "";
const checks = new Checks();
let stopNext: (() => void) | undefined;

try {
  pnpm(["db:migrate"], env);
  const keys = seededKeys(pnpm(["db:seed"], env));
  const keyA = keys["a@tokengrid.local"];
  const keyB = keys["b@tokengrid.local"];
  assert.ok(keyA && keyB);
  execFileSync(process.platform === "win32" ? "pnpm.cmd" : "pnpm", ["--filter", "@tokengrid/ingest", "credential", "--email", "admin@tokengrid.local", "--provider", "anthropic", "--kind", "admin", "--scope", WORKSPACE], {
    cwd: REPO,
    env: { ...env, TOKENGRID_CREDENTIAL: ADMIN_KEY },
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  const { db, sql } = createDb();

  // ---- fake Anthropic: serves calls and remembers what it truly billed ----
  const trueUsage = new Map<string, NormalizedUsage>();
  let n = 0;
  const upstream = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString()) as { model: string };
      const usage = { input_tokens: 2_000 + 40 * n, output_tokens: 800 + 10 * n };
      const t = trueUsage.get(body.model) ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0 };
      trueUsage.set(body.model, { ...t, inputTokens: t.inputTokens + usage.input_tokens, outputTokens: t.outputTokens + usage.output_tokens });
      res.writeHead(200, { "content-type": "application/json", "request-id": `req_${++n}` });
      res.end(JSON.stringify({ id: `msg_${n}`, type: "message", model: body.model, stop_reason: "end_turn", usage }));
    });
  });

  // ---- fake Anthropic Admin API cost report (cents, paginated, two workspaces) ----
  let costCalls = 0;
  const admin = createServer((req: IncomingMessage, res: ServerResponse) => {
    costCalls++;
    assert.equal(req.headers["x-api-key"], ADMIN_KEY);
    const url = new URL(req.url ?? "/", "http://x");
    assert.equal(url.pathname, "/v1/organizations/cost_report");
    assert.deepEqual(url.searchParams.getAll("group_by[]"), ["description", "workspace_id"]);
    const results = [...trueUsage].map(([model, u]) => {
      const rates = CATALOG.find((c) => c.providerModelId === model);
      assert.ok(rates);
      const cents = (Number(computeCost(u, rates).costUsd) * 100).toFixed(6);
      return { amount: cents, currency: "USD", model, cost_type: "tokens", description: `${model} usage`, workspace_id: WORKSPACE, token_type: null, service_tier: "standard", context_window: "0-200k", inference_geo: "global" };
    });
    // Traffic that never went through TokenGrid, in another workspace: must be ignored.
    results.push({ amount: "99999", currency: "USD", model: "claude-opus-5-5", cost_type: "tokens", description: "other", workspace_id: "wrkspc_other", token_type: null, service_tier: "standard", context_window: "0-200k", inference_geo: "global" });
    const first = url.searchParams.get("page") === null;
    const half = Math.ceil(results.length / 2);
    const bucket = { starting_at: url.searchParams.get("starting_at"), ending_at: url.searchParams.get("ending_at"), results: first ? results.slice(0, half) : results.slice(half) };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [bucket], has_more: first, next_page: first ? "page_2" : null }));
  });

  // ---- webhook receiver ----
  const webhooks: { text: string }[] = [];
  const hook = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      webhooks.push(JSON.parse(Buffer.concat(chunks).toString()) as { text: string });
      res.end("ok");
    });
  });
  await Promise.all([upstream, admin, hook].map((srv) => new Promise<void>((r) => srv.listen(0, r))));
  const port = (srv: typeof hook) => {
    const a = srv.address();
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
    adapters: [new FivePercentShortAdapter(`http://127.0.0.1:${port(upstream)}`)],
  });
  const gw = await app.listen({ port: 0, host: "127.0.0.1" });
  const prices = new PriceCache(db);
  await prices.load();
  for (let i = 0; i < 12; i++) {
    for (const model of ["claude-opus-5-5", BUGGY_MODEL]) {
      const res = await fetch(`${gw}/v1/messages`, {
        method: "POST",
        headers: { "x-api-key": i % 2 ? keyA : keyB, "content-type": "application/json" },
        body: JSON.stringify({ model, max_tokens: 1000, messages: [{ role: "user", content: `Question ${i} about ${model}` }] }),
      });
      await res.arrayBuffer();
    }
  }
  await sleep(30);
  for (let p = redis.stream.shift(); p !== undefined; p = redis.stream.shift()) {
    assert.equal(await processEntry(db, prices, `e-${randomBytes(4).toString("hex")}`, p, 1, quiet), "inserted");
  }

  // ---- reconcile today through the real CLI ----
  const day = new Date().toISOString().slice(0, 10);
  const reconcileEnv = { ...env, ANTHROPIC_ADMIN_URL: `http://127.0.0.1:${port(admin)}`, ALERT_WEBHOOK_URL: `http://127.0.0.1:${port(hook)}` };
  // Async on purpose: the fake admin API and webhook live in this process,
  // and a synchronous exec would block them from ever answering the CLI.
  const runReconcile = async () => {
    try {
      await promisify(execFile)(process.platform === "win32" ? "pnpm.cmd" : "pnpm", ["--filter", "@tokengrid/ingest", "reconcile", "--day", day], {
        cwd: REPO,
        env: reconcileEnv,
        encoding: "utf8",
        shell: process.platform === "win32",
      });
      return 0;
    } catch (err) {
      return (err as { code?: number }).code ?? 1;
    }
  };
  assert.notEqual(await runReconcile(), 0, "reconcile exits non-zero when drift is found");
  assert.equal(costCalls, 2, "both pages of the cost report were read");
  const recon = await sql<{ model: string; status: string; drift: string; billed: string; metered: string }[]>`
    select model, status, drift_ratio::text as drift, provider_usd::text as billed, metered_usd::text as metered from reconciliations order by model`;
  const buggy = one(recon.filter((r) => r.model === BUGGY_MODEL), "buggy model row");
  const healthy = one(recon.filter((r) => r.model === "claude-opus-5-5"), "healthy model row");
  assert.equal(buggy.status, "drift");
  assert.ok(Math.abs(Number(buggy.drift) + 0.05) < 0.002, `drift ${buggy.drift}`);
  assert.equal(healthy.status, "ok");
  assert.ok(Math.abs(Number(healthy.drift)) < 0.0005, "healthy model matches, and the other workspace's traffic was excluded");
  checks.ok(`5% metering bug caught: ${BUGGY_MODEL} drift ${(Number(buggy.drift) * 100).toFixed(2)}% (billed $${Number(buggy.billed).toFixed(4)}, metered $${Number(buggy.metered).toFixed(4)}); claude-opus-5-5 ok`);

  const alertRows = await sql<{ message: string }[]>`select message from alerts`;
  assert.equal(alertRows.length, 1);
  assert.ok(one(alertRows, "alert").message.includes(BUGGY_MODEL));
  assert.equal(webhooks.length, 1);
  assert.ok(webhooks[0]?.text.includes(BUGGY_MODEL));
  checks.ok(`alert fired once, names the model, delivered to the webhook: "${webhooks[0]?.text}"`);

  await runReconcile();
  assert.equal((await sql`select 1 from alerts`).length, 1, "re-running the day does not re-alert");
  assert.equal(webhooks.length, 1);
  checks.ok("re-running the same day updates rows without duplicating the alert");

  const users = await sql<{ id: string; org_id: string; email: string }[]>`select id, org_id, email from users`;
  const user = (email: string) => {
    const u = users.find((x) => x.email === email);
    assert.ok(u, email);
    return u;
  };
  const adminUser = user("admin@tokengrid.local");
  const view = await getReconciliation(db, { userId: adminUser.id, orgId: adminUser.org_id });
  assert.equal(view.drifted.length, 1);
  assert.equal(view.drifted[0]?.model, BUGGY_MODEL);
  const manager = user("manager@tokengrid.local");
  await assert.rejects(getReconciliation(db, { userId: manager.id, orgId: manager.org_id }), /org admins/);
  checks.ok("reconciliation view: drift as stored rows for admins, refused to non-admins");

  // ---- export ----
  const a = user("a@tokengrid.local");
  const records: Record<string, unknown>[] = [];
  for await (const r of exportUserData(db, a.id)) records.push(r);
  const aEvents = one(await sql<{ c: number }[]>`select count(*)::int as c from usage_events where user_id = ${a.id}`, "count").c;
  assert.equal(records[0]?.type, "profile");
  assert.equal(records.filter((r) => r.type === "usage_event").length, aEvents);
  assert.ok(!JSON.stringify(records).includes("ciphertext") && !JSON.stringify(records).includes("key_hash") && !JSON.stringify(records).includes("keyHash"));
  checks.ok(`export: profile, consents, keys (prefix only), ${aEvents} usage events; no secrets`);

  const next = await startNext(env);
  stopNext = next.stop;
  const cookieA = `tg_session=${signSession({ userId: a.id, orgId: a.org_id }, secret)}`;
  const exp = await fetch(`${next.url}/api/me/export`, { headers: { cookie: cookieA } });
  assert.equal(exp.status, 200);
  assert.equal(exp.headers.get("content-type"), "application/x-ndjson; charset=utf-8");
  // One line more than the direct call: the export itself is audited first, and that record is part of the export.
  const exported = (await exp.text()).trim().split("\n");
  assert.equal(exported.length, records.length + 1);
  assert.ok(exported.some((l) => l.includes('"data.exported"')));
  assert.equal(one(await sql<{ c: number }[]>`select count(*)::int as c from audit_log where action = 'data.exported'`, "audit").c, 1);
  checks.ok("GET /api/me/export streams the same NDJSON and records the export");

  // ---- delete on request ----
  const orgTotal = async () => one(await sql<{ v: string }[]>`select sum(cost_usd)::text as v from usage_rollup_hourly`, "total").v;
  const before = await orgTotal();
  const refused = await fetch(`${next.url}/api/me/delete`, { method: "POST", headers: { cookie: cookieA, "content-type": "application/json" }, body: "{}" });
  assert.equal(refused.status, 400);
  const aPayload = one(await sql<{ provider_request_id: string }[]>`select provider_request_id from usage_events where user_id = ${a.id} limit 1`, "a event");
  const del = await fetch(`${next.url}/api/me/delete`, {
    method: "POST",
    headers: { cookie: cookieA, "content-type": "application/json" },
    body: JSON.stringify({ confirm: "delete my usage data" }),
  });
  assert.equal(del.status, 200);
  assert.equal(await orgTotal(), before, "org totals unchanged");
  for (const table of ["usage_events", "usage_rollup_hourly", "prompt_features", "lint_findings", "efficiency_scores"]) {
    assert.equal(one(await sql<{ c: number }[]>`select count(*)::int as c from ${sql(table)} where user_id = ${a.id}`, table).c, 0, table);
  }
  assert.equal(one(await sql<{ c: number }[]>`select count(*)::int as c from drilldown_consents where subject_user_id = ${a.id}`, "consents").c, 0);
  const ph = one(await sql<{ v: string }[]>`select sum(r.cost_usd)::text as v from usage_rollup_hourly r join users u on u.id = r.user_id where u.display_name = 'Former member'`, "placeholder");
  assert.ok(Number(ph.v) > 0);
  checks.ok(`delete-on-request: A's events, findings, scores and consent gone; $${Number(ph.v).toFixed(4)} moved to "Former member"; org total unchanged ($${Number(before).toFixed(4)})`);

  const ledger = one(await sql<{ c: number }[]>`select count(*)::int as c from usage_event_ids where provider_request_id = ${aPayload.provider_request_id}`, "ledger").c;
  assert.equal(ledger, 1, "idempotency ledger kept, so a replay cannot resurrect the event");
  checks.ok("idempotency ledger survives deletion: a replayed event stays deleted");

  // ---- retention ----
  await sql`update organizations set retention_days = 30`;
  await sql`create table usage_events_old partition of usage_events for values from ('2025-01-01') to ('2025-02-01')`;
  const b = user("b@tokengrid.local");
  const bKey = one(await sql<{ id: string; price: string }[]>`select v.id, (select id from model_prices limit 1) as price from virtual_keys v where v.user_id = ${b.id} limit 1`, "b key");
  await sql`insert into usage_events (occurred_at, provider, provider_request_id, org_id, user_id, virtual_key_id, model, pricing_tier, price_id,
      input_tokens, output_tokens, cache_read_tokens, cache_write_5m_tokens, cache_write_1h_tokens, cost_usd, duration_ms, http_status, streamed, usage_complete)
    values ('2025-01-15', 'anthropic', 'req_ancient', ${b.org_id}, ${b.id}, ${bKey.id}, 'claude-opus-5-5', 'standard', ${bKey.price}, 1, 1, 0, 0, 0, 0.01, 10, 200, false, true)`;
  await sql`insert into usage_rollup_hourly (bucket_start, org_id, user_id, virtual_key_id, provider, model, requests, incomplete_requests, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd)
    values ('2025-01-15', ${b.org_id}, ${b.id}, ${bKey.id}, 'anthropic', 'claude-opus-5-5', 1, 0, 1, 1, 0, 0, 0.01)`;
  const recentBefore = one(await sql<{ c: number }[]>`select count(*)::int as c from usage_events where occurred_at > now() - interval '1 day'`, "recent").c;
  const [report] = await applyRetention(db);
  assert.ok(report && report.deleted.usageEvents === 1 && report.deleted.rollups === 1);
  assert.equal(one(await sql<{ c: number }[]>`select count(*)::int as c from usage_events where occurred_at > now() - interval '1 day'`, "recent").c, recentBefore);
  checks.ok("retention: 30-day org drops its 2025 event and rollup, keeps this week");

  await app.close();
  for (const srv of [upstream, admin, hook]) srv.close();
  await sql.end();
} finally {
  stopNext?.();
  await pg.stop();
  console.log(`\nstage 5: ${checks.passed} checks passed`);
}
