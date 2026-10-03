import { gte, sql } from "drizzle-orm";
import { schema, type Database } from "@tokengrid/db";
import {
  BUDGET_INDEX_KEY,
  budgetLimitKey,
  budgetPeriod,
  parseDecimal,
  periodStart,
  picoToNanoCeil,
  spendKey,
  usdToNano,
  COST_SCALE,
  BUDGET_SCOPES,
  type BudgetScope,
  type UsageEventV1,
} from "@tokengrid/shared";

/** Counters outlive their month long enough to answer "what did last month end at". */
const SPEND_TTL_S = 40 * 24 * 3600;

/**
 * Raises a counter to `floor` if it is below it; never lowers it. Lua so the
 * read and the write cannot interleave with a concurrent INCRBY.
 */
const RAISE_TO_FLOOR = `
local cur = tonumber(redis.call('GET', KEYS[1]) or '0')
if cur < tonumber(ARGV[1]) then
  redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
  return 1
end
return 0`;

export interface SpendRedis {
  multi(): {
    incrby(key: string, n: string): unknown;
    expire(key: string, s: number): unknown;
    exec(): Promise<unknown>;
  };
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
  set(key: string, value: string): Promise<unknown>;
  sadd(key: string, ...members: string[]): Promise<unknown>;
  smembers(key: string): Promise<string[]>;
  del(...keys: string[]): Promise<unknown>;
  srem(key: string, ...members: string[]): Promise<unknown>;
}

function scopesOf(e: Pick<UsageEventV1, "virtualKeyId" | "userId" | "orgId">): [BudgetScope, string][] {
  return [
    ["key", e.virtualKeyId],
    ["user", e.userId],
    ["org", e.orgId],
  ];
}

/**
 * Redis spend counters that the gateway's budget check reads.
 *
 * They are a cache of the rollups, not a ledger. `add` runs after the insert
 * commits, so a crash in between leaves the counter low (the redelivery is a
 * duplicate and does not add again). `syncFromRollups` repairs that by
 * raising every counter to the rollup total; raising only, never lowering,
 * means it cannot erase an increment that landed after its query ran.
 */
export class SpendCounters {
  constructor(private readonly redis: SpendRedis) {}

  async add(event: UsageEventV1, costPico: bigint): Promise<void> {
    if (costPico === 0n) return;
    const nano = picoToNanoCeil(costPico).toString();
    const period = budgetPeriod(new Date(event.occurredAt));
    const m = this.redis.multi();
    for (const [scope, id] of scopesOf(event)) {
      const k = spendKey(scope, id, period);
      m.incrby(k, nano);
      m.expire(k, SPEND_TTL_S);
    }
    await m.exec();
  }

  async syncFromRollups(db: Database, now = new Date()): Promise<number> {
    const r = schema.usageRollupHourly;
    const rows = await db
      .select({
        orgId: r.orgId,
        userId: r.userId,
        virtualKeyId: r.virtualKeyId,
        cost: sql<string>`sum(${r.costUsd})::text`,
      })
      .from(r)
      .where(gte(r.bucketStart, periodStart(now)))
      .groupBy(r.orgId, r.userId, r.virtualKeyId);

    const totals = new Map<string, bigint>();
    const period = budgetPeriod(now);
    for (const row of rows) {
      const pico = parseDecimal(row.cost, COST_SCALE);
      for (const [scope, id] of scopesOf(row)) {
        const k = spendKey(scope, id, period);
        totals.set(k, (totals.get(k) ?? 0n) + pico);
      }
    }
    let raised = 0;
    for (const [k, pico] of totals) {
      raised += Number(await this.redis.eval(RAISE_TO_FLOOR, 1, k, picoToNanoCeil(pico).toString(), SPEND_TTL_S));
    }
    return raised;
  }

  /** Mirrors the budgets table into Redis, deleting limits that were removed. */
  async syncBudgets(db: Database): Promise<number> {
    const rows = await db
      .select({ scope: schema.budgets.scope, scopeId: schema.budgets.scopeId, limitUsd: schema.budgets.limitUsd })
      .from(schema.budgets);
    const live = new Set<string>();
    for (const b of rows) {
      if (!(BUDGET_SCOPES as readonly string[]).includes(b.scope)) continue;
      const k = budgetLimitKey(b.scope as BudgetScope, b.scopeId);
      live.add(k);
      await this.redis.set(k, usdToNano(b.limitUsd).toString());
    }
    if (live.size > 0) await this.redis.sadd(BUDGET_INDEX_KEY, ...live);
    const stale = (await this.redis.smembers(BUDGET_INDEX_KEY)).filter((k) => !live.has(k));
    if (stale.length > 0) {
      await this.redis.del(...stale);
      await this.redis.srem(BUDGET_INDEX_KEY, ...stale);
    }
    return rows.length;
  }
}
