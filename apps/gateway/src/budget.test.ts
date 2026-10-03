import { test } from "node:test";
import assert from "node:assert/strict";
import { budgetLimitKey, spendKey } from "@tokengrid/shared";
import { BudgetGuard, budgetExceededMessage } from "./budget.js";

const key = { virtualKeyId: "k1", userId: "u1", orgId: "o1", upstreamKeys: {} };
const now = new Date("2026-10-15T12:00:00Z");
const quiet = { warn: () => {} };

function guard(values: Record<string, string>) {
  return new BudgetGuard({ mget: async (...keys: string[]) => keys.map((k) => values[k] ?? null) }, quiet);
}

test("no budgets configured: neither blocked nor warned", async () => {
  assert.deepEqual(await guard({}).check(key, now), { blocked: null, warning: null });
});

test("spend at the limit blocks, and the message names limit and spend", async () => {
  const v = await guard({
    [budgetLimitKey("user", "u1")]: "1000000000",
    [spendKey("user", "u1", "2026-10")]: "1000000001",
  }).check(key, now);
  assert.ok(v.blocked);
  assert.equal(v.blocked.scope, "user");
  // Spend rounds up so a crossed cap never reads as under it.
  assert.match(budgetExceededMessage(v.blocked), /monthly limit \$1\.00, spent \$1\.01 in 2026-10/);
});

test("warning from 80%, reporting the most-used scope", async () => {
  const v = await guard({
    [budgetLimitKey("user", "u1")]: "100",
    [spendKey("user", "u1", "2026-10")]: "81",
    [budgetLimitKey("org", "o1")]: "100",
    [spendKey("org", "o1", "2026-10")]: "95",
  }).check(key, now);
  assert.equal(v.blocked, null);
  assert.equal(v.warning?.scope, "org");
});

test("last month's spend does not count against this month", async () => {
  const v = await guard({
    [budgetLimitKey("key", "k1")]: "100",
    [spendKey("key", "k1", "2026-09")]: "500",
  }).check(key, now);
  assert.equal(v.blocked, null);
});

test("redis down fails open", async () => {
  const g = new BudgetGuard({ mget: async () => { throw new Error("ECONNREFUSED"); } }, quiet);
  assert.deepEqual(await g.check(key, now), { blocked: null, warning: null });
});
