/**
 * Stage 6 acceptance: a cold deploy from an empty database reaches a working
 * dashboard using only the steps in DEPLOY.md ("Rehearsal without Docker"):
 * production bundles, a real Redis (consumer groups, backlog, replay), the
 * admin CLIs, a one-time sign-in link, and the dashboard.
 *
 * Needs a redis-server binary: on PATH, or REDIS_SERVER_BIN=<path>.
 */
import assert from "node:assert/strict";
import { execFile, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { promisify } from "node:util";
import { createDb } from "@tokengrid/db";
import { Checks, freePort, REPO, sleep, startPostgres } from "./harness.js";

const run = promisify(execFile);
const checks = new Checks();
const redisBin = process.env.REDIS_SERVER_BIN ?? "redis-server";
if (spawnSync(redisBin, ["--version"]).status !== 0) {
  console.log(`SKIPPED stage 6: no redis-server found (set REDIS_SERVER_BIN). This stage needs a real Redis.`);
  process.exit(0);
}
for (const bundle of ["apps/gateway/dist/index.js", "apps/ingest/dist/worker.js", "packages/db/dist/migrate.js", "apps/web/.next/BUILD_ID"]) {
  assert.ok(existsSync(join(REPO, bundle)), `${bundle} missing: run pnpm build:services && pnpm build:web first (DEPLOY.md)`);
}

const children: ChildProcess[] = [];
const logs = new Map<string, string>();
function start(name: string, args: string[], env: NodeJS.ProcessEnv, cwd = REPO): ChildProcess {
  const child = spawn(process.execPath, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  logs.set(name, "");
  const keep = (d: Buffer) => logs.set(name, ((logs.get(name) ?? "") + d.toString()).slice(-20_000));
  child.stdout?.on("data", keep);
  child.stderr?.on("data", keep);
  children.push(child);
  return child;
}
async function waitFor(url: string, what: string) {
  for (let i = 0; i < 120; i++) {
    try {
      await fetch(url);
      return;
    } catch {
      await sleep(500);
    }
  }
  throw new Error(`${what} did not start:\n${[...logs].map(([k, v]) => `--- ${k}\n${v}`).join("\n")}`);
}

const redisPort = await freePort();
const redis = spawn(redisBin, ["--port", String(redisPort), "--save", "", "--appendonly", "no"], { stdio: "ignore" });
const pg = await startPostgres();
const gatewayPort = await freePort();
const webPort = await freePort();

// ---- fake Anthropic ----
let n = 0;
const upstream = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    const body = JSON.parse(Buffer.concat(chunks).toString()) as { model: string };
    res.writeHead(200, { "content-type": "application/json", "request-id": `req_${++n}` });
    res.end(JSON.stringify({ id: `msg_${n}`, type: "message", model: body.model, stop_reason: "end_turn", usage: { input_tokens: 1200, output_tokens: 300 } }));
  });
});
await new Promise<void>((r) => upstream.listen(0, r));
const upstreamAddr = upstream.address();
assert.ok(upstreamAddr && typeof upstreamAddr === "object");

// The documented environment, nothing more.
const env: NodeJS.ProcessEnv = {
  PATH: process.env.PATH,
  SystemRoot: process.env.SystemRoot,
  DATABASE_URL: pg.url,
  REDIS_URL: `redis://127.0.0.1:${redisPort}`,
  TOKENGRID_LOCAL_KEK: randomBytes(32).toString("base64"),
  TOKENGRID_SESSION_SECRET: randomBytes(32).toString("hex"),
  ANTHROPIC_UPSTREAM_URL: `http://127.0.0.1:${upstreamAddr.port}`,
  GATEWAY_PORT: String(gatewayPort),
  GATEWAY_HOST: "127.0.0.1",
};
const node = (script: string, args: string[] = [], extra: NodeJS.ProcessEnv = {}) =>
  run(process.execPath, [join(REPO, script), ...args], { cwd: REPO, env: { ...env, ...extra }, encoding: "utf8" });

try {
  // 1. Migrate an empty database.
  await node("packages/db/dist/migrate.js");
  const { sql } = createDb(pg.url, { max: 1 });
  const tables = await sql<{ c: number }[]>`select count(*)::int as c from information_schema.tables where table_schema = 'public'`;
  assert.ok((tables[0]?.c ?? 0) > 15);
  checks.ok(`migrate.js on an empty database: ${tables[0]?.c} tables`);

  // 2. Bootstrap with the admin CLIs.
  await node("apps/ingest/dist/admin-cli.js", ["org", "create", "--name", "Acme", "--admin-email", "ops@acme.test", "--admin-name", "Ops"]);
  await node("apps/ingest/dist/admin-cli.js", ["team", "member", "--org", "Acme", "--team", "Platform", "--email", "ops@acme.test", "--role", "manager"]);
  await node("apps/ingest/dist/credential-cli.js", ["--email", "ops@acme.test", "--provider", "anthropic"], { TOKENGRID_CREDENTIAL: "sk-ant-real-looking" });
  const issued = await node("apps/ingest/dist/admin-cli.js", ["key", "issue", "--email", "ops@acme.test", "--name", "laptop"]);
  const key = /tgk_[A-Za-z0-9_-]{43}/.exec(issued.stdout)?.[0];
  assert.ok(key, issued.stdout);
  const prices = await sql<{ c: number }[]>`select count(*)::int as c from model_prices`;
  assert.ok((prices[0]?.c ?? 0) > 0, "migrate loads the price catalog");
  checks.ok(`bootstrap CLIs: org, team, encrypted credential, virtual key; ${prices[0]?.c} catalog prices loaded by migrate`);

  // 3. Start the three processes from their bundles.
  start("gateway", [join(REPO, "apps/gateway/dist/index.js")], env);
  start("worker", [join(REPO, "apps/ingest/dist/worker.js")], env);
  start("web", [join(REPO, "apps/web/node_modules/next/dist/bin/next"), "start", "-p", String(webPort)], { ...env, NODE_ENV: "production" }, join(REPO, "apps/web"));
  const gw = `http://127.0.0.1:${gatewayPort}`;
  const web = `http://127.0.0.1:${webPort}`;
  await waitFor(`${gw}/healthz`, "gateway");
  await waitFor(`${web}/login`, "dashboard");
  checks.ok("gateway, worker and dashboard start from the production bundles");

  // 4. Calls flow gateway -> real Redis stream -> worker -> Postgres.
  const call = async (i: number) => {
    const res = await fetch(`${gw}/anthropic/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-haiku-4-5", max_tokens: 64, messages: [{ role: "user", content: `ping ${i}` }] }),
    });
    assert.equal(res.status, 200, await res.text());
  };
  const events = async () => (await sql<{ c: number }[]>`select count(*)::int as c from usage_events`)[0]?.c ?? 0;
  const until = async (count: number) => {
    for (let i = 0; i < 60 && (await events()) < count; i++) await sleep(250);
    return events();
  };
  for (let i = 0; i < 3; i++) await call(i);
  assert.equal(await until(3), 3, logs.get("worker"));
  checks.ok("3 calls metered end to end through a real Redis consumer group");

  // 5. Sign in with a one-time link and see the calls on the dashboard.
  const link = (await node("apps/ingest/dist/admin-cli.js", ["login-link", "--email", "ops@acme.test", "--base-url", web])).stdout.trim();
  const signIn = await fetch(link, { redirect: "manual" });
  assert.equal(signIn.status, 303);
  assert.equal(new URL(signIn.headers.get("location") ?? "", web).pathname, "/usage");
  const cookie = (signIn.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  assert.ok(cookie.startsWith("tg_session="));
  const usage = (await (await fetch(`${web}/api/usage?view=self&period=7d`, { headers: { cookie } })).json()) as { totals: { requests: number; costUsd: string } };
  assert.equal(usage.totals.requests, 3);
  assert.ok(Number(usage.totals.costUsd) > 0);
  assert.equal((await fetch(`${web}/usage`, { headers: { cookie } })).status, 200);
  const reused = await fetch(link, { redirect: "manual" });
  assert.equal(new URL(reused.headers.get("location") ?? "", web).search, "?error=link");
  checks.ok(`sign-in link -> dashboard shows 3 requests, $${usage.totals.costUsd}; the link does not work twice`);

  // 6. Worker down: events wait in the stream and are consumed on restart.
  const worker = children.find((c) => c.spawnargs.some((a) => a.endsWith("worker.js")));
  worker?.kill();
  await sleep(300);
  for (let i = 3; i < 5; i++) await call(i);
  await sleep(500);
  assert.equal(await events(), 3, "nothing ingested while the worker is down");
  start("worker-2", [join(REPO, "apps/ingest/dist/worker.js")], env);
  assert.equal(await until(5), 5, logs.get("worker-2"));
  checks.ok("worker restart consumes the 2 events queued while it was down");

  // 7. Replaying the whole stream twice changes nothing.
  for (let i = 0; i < 2; i++) {
    const out = JSON.parse((await node("apps/ingest/dist/replay.js")).stdout) as { usageEventsBefore: number; usageEventsAfter: number; outcomes: Record<string, number> };
    assert.equal(out.usageEventsAfter, out.usageEventsBefore);
    assert.equal(out.outcomes.duplicate, 5);
  }
  checks.ok("replay.js over the real stream, twice: 5 duplicates each time, row count unchanged");

  // 8. The local key refuses to run in production.
  const prodPort = await freePort();
  start("gateway-prod", [join(REPO, "apps/gateway/dist/index.js")], { ...env, NODE_ENV: "production", GATEWAY_PORT: String(prodPort) });
  await waitFor(`http://127.0.0.1:${prodPort}/healthz`, "production gateway");
  const refused = await fetch(`http://127.0.0.1:${prodPort}/anthropic/v1/messages`, {
    method: "POST",
    headers: { "x-api-key": key, "content-type": "application/json" },
    body: JSON.stringify({ model: "claude-haiku-4-5", max_tokens: 8, messages: [{ role: "user", content: "x" }] }),
  });
  assert.equal(refused.status, 500);
  await sleep(100);
  assert.ok((logs.get("gateway-prod") ?? "").includes("LocalKeyInProductionError"));
  checks.ok("with NODE_ENV=production the local-key credential is refused (LocalKeyInProductionError); KMS is required");

  await sql.end();
} finally {
  for (const c of children) c.kill();
  redis.kill();
  upstream.close();
  await pg.stop();
  console.log(`\nstage 6: ${checks.passed} checks passed`);
}
