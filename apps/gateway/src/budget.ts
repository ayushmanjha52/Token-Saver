import {
  budgetLimitKey,
  budgetPeriod,
  formatUsd,
  periodEnd,
  spendKey,
  type BudgetScope,
} from "@tokengrid/shared";
import type { ResolvedKey } from "./auth.js";

export const BUDGET_WARNING_HEADER = "x-tokengrid-budget-warning";

export interface BudgetStatus {
  scope: BudgetScope;
  limitNano: bigint;
  spentNano: bigint;
  period: string;
  resetsAt: Date;
}

export interface BudgetVerdict {
  blocked: BudgetStatus | null;
  warning: BudgetStatus | null;
}

const SCOPE_LABEL: Record<BudgetScope, string> = { key: "key", user: "personal", org: "organization" };

export function budgetExceededMessage(s: BudgetStatus): string {
  return (
    `TokenGrid ${SCOPE_LABEL[s.scope]} budget exceeded: monthly limit ${formatUsd(s.limitNano, "floor")}, ` +
    `spent ${formatUsd(s.spentNano, "ceil")} in ${s.period} (UTC). Resets ${s.resetsAt.toISOString()}.`
  );
}

export function budgetWarningValue(s: BudgetStatus): string {
  const pct = s.limitNano === 0n ? 100n : (s.spentNano * 100n) / s.limitNano;
  return `scope=${s.scope}; used=${pct}%; spent=${formatUsd(s.spentNano, "ceil")}; limit=${formatUsd(s.limitNano, "floor")}; period=${s.period}`;
}

function parseNano(v: string | null | undefined): bigint | null {
  if (v === null || v === undefined || !/^\d+$/.test(v)) return null;
  return BigInt(v);
}

/**
 * Synchronous pre-forward budget check: one MGET for the limit and current
 * spend of the key, its user and its org.
 *
 * Spend counters move only when the ingest worker records a finished call,
 * so concurrent requests all pass the check against the same figure; the
 * worst-case overshoot is the cost of the calls in flight when the cap is
 * crossed. Reserving an estimate up front would close that, at the price of
 * blocking users on spend they never incur; the overshoot is the cheaper
 * error at the current caps.
 *
 * If Redis is unreachable the check fails open. A budget is a spending
 * policy, not a security boundary, and refusing every completion during a
 * cache outage is the larger harm.
 */
export class BudgetGuard {
  constructor(
    private readonly redis: { mget(...keys: string[]): Promise<(string | null)[]> },
    private readonly log: { warn: (obj: object, msg: string) => void },
  ) {}

  async check(k: ResolvedKey, now: Date): Promise<BudgetVerdict> {
    const period = budgetPeriod(now);
    const scopes: [BudgetScope, string][] = [
      ["key", k.virtualKeyId],
      ["user", k.userId],
      ["org", k.orgId],
    ];
    let values: (string | null)[];
    try {
      values = await this.redis.mget(...scopes.flatMap(([s, id]) => [budgetLimitKey(s, id), spendKey(s, id, period)]));
    } catch (err) {
      this.log.warn({ err }, "budget check skipped: redis unavailable (failing open)");
      return { blocked: null, warning: null };
    }

    let blocked: BudgetStatus | null = null;
    let warning: BudgetStatus | null = null;
    scopes.forEach(([scope], i) => {
      const limitNano = parseNano(values[2 * i]);
      if (limitNano === null) return;
      const spentNano = parseNano(values[2 * i + 1]) ?? 0n;
      const status: BudgetStatus = { scope, limitNano, spentNano, period, resetsAt: periodEnd(now) };
      if (spentNano >= limitNano) {
        // Report the narrowest exceeded scope: it names the limit the caller can actually act on.
        blocked ??= status;
      } else if (spentNano * 5n >= limitNano * 4n) {
        // Report the most-used scope among those past 80%.
        if (!warning || spentNano * warning.limitNano > warning.spentNano * limitNano) warning = status;
      }
    });
    return { blocked, warning };
  }
}
