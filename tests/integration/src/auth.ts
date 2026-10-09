/**
 * Self-service accounts through the built dashboard: sign-up, sign-in,
 * lockout, rate limits, cross-site refusal, and link-only users setting a
 * first password. Real Postgres 16, real Next server, plain HTTP.
 */
import assert from "node:assert/strict";
import { createDb } from "@tokengrid/db";
import { signSession } from "../../../apps/web/src/lib/session-token.js";
import { Checks, one, pnpm, startNext, startPostgres, testEnv } from "./harness.js";

const pg = await startPostgres();
const env = testEnv(pg.url);
const secret = env.TOKENGRID_SESSION_SECRET ?? "";
const checks = new Checks();
let stopNext: (() => void) | undefined;

interface Result {
  status: number;
  location: URL | null;
  cookie: string | null;
}

try {
  pnpm(["db:migrate"], env);
  pnpm(["db:seed"], env);
  const { sql } = createDb();
  const next = await startNext(env);
  stopNext = next.stop;

  const post = async (path: string, fields: Record<string, string>, headers: Record<string, string> = {}): Promise<Result> => {
    const res = await fetch(`${next.url}${path}`, { method: "POST", body: new URLSearchParams(fields), redirect: "manual", headers });
    const loc = res.headers.get("location");
    const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0] || null;
    return { status: res.status, location: loc ? new URL(loc, next.url) : null, cookie };
  };
  const errorOf = (r: Result) => r.location?.searchParams.get("error") ?? null;
  const usage = async (cookie: string) =>
    (await (await fetch(`${next.url}/api/usage?view=self`, { headers: { cookie } })).json()) as { viewer: { displayName: string; orgRole: string; hasPassword: boolean } };

  assert.equal((await fetch(`${next.url}/signup`)).status, 200);
  assert.equal((await fetch(`${next.url}/login`)).status, 200);
  checks.ok("sign-up and sign-in pages render");

  // ---- sign up ----
  const ada = { name: "Ada Lovelace", email: "Ada@Example.com", organization: "Analytical Engines", password: "difference engine 1842" };
  const created = await post("/api/auth/signup", ada);
  assert.equal(created.status, 303);
  assert.equal(created.location?.pathname, "/usage");
  assert.ok(created.cookie?.startsWith("tg_session="));
  const me = await usage(created.cookie ?? "");
  assert.deepEqual(me.viewer, { ...me.viewer, displayName: "Ada Lovelace", orgRole: "admin", hasPassword: true });
  const row = one(await sql<{ org: string; hash: string; email: string }[]>`
    select o.name as org, u.password_hash as hash, u.email from users u join organizations o on o.id = u.org_id where u.email = 'ada@example.com'`, "ada");
  assert.equal(row.org, "Analytical Engines");
  assert.ok(row.hash.startsWith("scrypt$") && !row.hash.includes("difference"));
  checks.ok("sign-up creates a new org with the person as admin, signs them in, stores only a scrypt hash");

  assert.equal(errorOf(await post("/api/auth/signup", { ...ada, email: "ADA@example.com" })), "email_taken");
  assert.equal(errorOf(await post("/api/auth/signup", { ...ada, email: "a@tokengrid.local" })), "email_taken");
  const short = await post("/api/auth/signup", { ...ada, email: "new@example.com", password: "short" });
  assert.equal(errorOf(short), "invalid_input");
  assert.match(short.location?.searchParams.get("message") ?? "", /at least 10 characters/);
  checks.ok("duplicate emails (any case, any org) and weak passwords are refused with a reason");

  const forged = await post("/api/auth/signup", { ...ada, email: "csrf@example.com" }, { origin: "https://evil.example" });
  assert.equal(errorOf(forged), "origin");
  assert.equal(forged.cookie, null);
  assert.equal((await sql`select 1 from users where email = 'csrf@example.com'`).length, 0);
  checks.ok("cross-site sign-up is refused and creates nothing");

  // ---- sign in ----
  assert.equal(errorOf(await post("/api/auth/signin", { email: "ada@example.com", password: "wrong password!" })), "bad_credentials");
  assert.equal(errorOf(await post("/api/auth/signin", { email: "nobody@example.com", password: "whatever12345" })), "bad_credentials");
  const signedIn = await post("/api/auth/signin", { email: "ADA@example.com", password: ada.password });
  assert.equal(signedIn.location?.pathname, "/usage");
  assert.equal((await usage(signedIn.cookie ?? "")).viewer.displayName, "Ada Lovelace");
  checks.ok("sign-in: same answer for wrong password and unknown email; right password signs in (email case-insensitive)");

  for (let i = 0; i < 10; i++) await post("/api/auth/signin", { email: "ada@example.com", password: `wrong ${i} attempt` }, { "x-forwarded-for": `198.51.100.${i}` });
  assert.equal(errorOf(await post("/api/auth/signin", { email: "ada@example.com", password: ada.password }, { "x-forwarded-for": "198.51.100.50" })), "locked");
  await sql`update users set locked_until = now() - interval '1 second' where email = 'ada@example.com'`;
  assert.equal((await post("/api/auth/signin", { email: "ada@example.com", password: ada.password }, { "x-forwarded-for": "198.51.100.51" })).location?.pathname, "/usage");
  checks.ok("10 failed passwords lock the account for 15 minutes, even across addresses; it opens again afterwards");

  const ip = { "x-forwarded-for": "203.0.113.9" };
  const results = [];
  for (let i = 0; i < 6; i++) results.push(errorOf(await post("/api/auth/signup", { ...ada, email: `bulk${i}@example.com` }, ip)));
  assert.deepEqual(results, [null, null, null, null, null, "throttled"]);
  checks.ok("sign-up is rate limited: the 6th account from one address within an hour is refused");

  // ---- link-only member sets a first password ----
  const [manager] = await sql<{ id: string; org_id: string }[]>`select id, org_id from users where email = 'manager@tokengrid.local'`;
  assert.ok(manager);
  const cookie = `tg_session=${signSession({ userId: manager.id, orgId: manager.org_id }, secret)}`;
  assert.equal((await usage(cookie)).viewer.hasPassword, false);
  const setPw = async (body: object) =>
    fetch(`${next.url}/api/auth/password`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) });
  assert.equal((await setPw({ next: "manager password 1" })).status, 200);
  assert.equal((await post("/api/auth/signin", { email: "manager@tokengrid.local", password: "manager password 1" }, { "x-forwarded-for": "192.0.2.1" })).location?.pathname, "/usage");
  assert.equal((await setPw({ current: "not it", next: "manager password 2" })).status, 403);
  assert.equal((await setPw({ current: "manager password 1", next: "manager password 2" })).status, 200);
  checks.ok("a link-only member sets a first password, signs in with it, and changing it requires the current one");

  await sql.end();
} finally {
  stopNext?.();
  await pg.stop();
  console.log(`\nauth: ${checks.passed} checks passed`);
}
