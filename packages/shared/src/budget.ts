import { InvalidDecimalError } from "./errors.js";

export const BUDGET_SCOPES = ["key", "user", "org"] as const;
export type BudgetScope = (typeof BUDGET_SCOPES)[number];

/**
 * Budgets and spend counters are kept in nano-dollars in Redis: INCRBY is a
 * signed 64-bit add, so pico-dollars would overflow at ~$9.2M per counter
 * while nano-dollars only do at ~$9.2B.
 */
export const NANO_PER_USD = 1_000_000_000n;

/** Budget periods are calendar months in UTC, matching provider invoices. */
export function budgetPeriod(at: Date): string {
  return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function periodStart(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
}

export function periodEnd(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1));
}

export function budgetLimitKey(scope: BudgetScope, id: string): string {
  return `tg:budget:${scope}:${id}`;
}

export function spendKey(scope: BudgetScope, id: string, period: string): string {
  return `tg:spend:${scope}:${id}:${period}`;
}

/** Index of every budget key written to Redis, so the sync can delete removed budgets. */
export const BUDGET_INDEX_KEY = "tg:budget:index";

/**
 * Rounds up: a counter that under-reads by a fraction of a cent per event
 * lets a capped user drift past the cap, so the error goes the other way.
 */
export function picoToNanoCeil(pico: bigint): bigint {
  return (pico + 999n) / 1000n;
}

export function usdToNano(usd: string): bigint {
  const m = /^(\d+)(?:\.(\d{1,9}))?$/.exec(usd.trim());
  if (!m) throw new InvalidDecimalError(usd, 9);
  return BigInt(m[1] ?? "0") * NANO_PER_USD + BigInt((m[2] ?? "").padEnd(9, "0") || "0");
}

/**
 * Formats to cents. `ceil` is for amounts spent (so a cap that has been
 * crossed never displays as under it), `floor` for amounts remaining.
 */
export function formatUsd(nano: bigint, rounding: "ceil" | "floor" = "floor"): string {
  const perCent = NANO_PER_USD / 100n;
  const cents = rounding === "ceil" ? (nano + perCent - 1n) / perCent : nano / perCent;
  return `$${(cents / 100n).toLocaleString("en-US")}.${String(cents % 100n).padStart(2, "0")}`;
}
