import { InvalidDecimalError } from "./errors.js";
import type { NormalizedUsage } from "./usage.js";

/**
 * Rates in USD per million tokens, as decimal strings exactly as Postgres
 * returns `numeric`. Strings, not numbers, because $0.20/MTok has no exact
 * binary float and the error compounds across millions of events.
 */
export interface PriceRates {
  inputPerMtok: string;
  outputPerMtok: string;
  cacheReadPerMtok: string;
  cacheWrite5mPerMtok: string;
  cacheWrite1hPerMtok: string;
}

/** Fractional digits allowed in a $/MTok rate (micro-dollar precision). */
export const RATE_SCALE = 6;
/** Fractional digits of a computed cost (pico-dollars: rate scale + 1e-6 per token). */
export const COST_SCALE = 12;

export function parseDecimal(value: string, scale: number): bigint {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!m) throw new InvalidDecimalError(value, scale);
  const whole = m[1] ?? "0";
  const frac = (m[2] ?? "").replace(/0+$/, "");
  if (frac.length > scale) throw new InvalidDecimalError(value, scale);
  return BigInt(whole) * 10n ** BigInt(scale) + BigInt(frac.padEnd(scale, "0") || "0");
}

export function formatDecimal(value: bigint, scale: number): string {
  const neg = value < 0n;
  const abs = neg ? -value : value;
  const base = 10n ** BigInt(scale);
  const whole = abs / base;
  const frac = (abs % base).toString().padStart(scale, "0");
  return `${neg ? "-" : ""}${whole}.${frac}`;
}

export interface CostBreakdown {
  /** Exact total, in pico-dollars. */
  totalPico: bigint;
  /** Exact total as a `numeric(…, 12)` literal. */
  costUsd: string;
  componentsPico: Record<keyof NormalizedUsage, bigint>;
}

/**
 * Integer arithmetic end to end: tokens × micro-dollars-per-MTok is exactly
 * pico-dollars, so a day's sum in Postgres equals the sum of the parts with
 * no rounding step anywhere to argue about during reconciliation.
 */
export function computeCost(usage: NormalizedUsage, rates: PriceRates): CostBreakdown {
  const r = (s: string) => parseDecimal(s, RATE_SCALE);
  const componentsPico = {
    inputTokens: BigInt(usage.inputTokens) * r(rates.inputPerMtok),
    outputTokens: BigInt(usage.outputTokens) * r(rates.outputPerMtok),
    cacheReadTokens: BigInt(usage.cacheReadTokens) * r(rates.cacheReadPerMtok),
    cacheWrite5mTokens: BigInt(usage.cacheWrite5mTokens) * r(rates.cacheWrite5mPerMtok),
    cacheWrite1hTokens: BigInt(usage.cacheWrite1hTokens) * r(rates.cacheWrite1hPerMtok),
  };
  const totalPico = Object.values(componentsPico).reduce((a, b) => a + b, 0n);
  return { totalPico, costUsd: formatDecimal(totalPico, COST_SCALE), componentsPico };
}

export interface PriceVersion extends PriceRates {
  id: string;
  effectiveFrom: Date;
  /** Exclusive. Null means still current. */
  effectiveTo: Date | null;
}

/**
 * Picks the version in force at `at`. When ranges overlap (a data-entry
 * mistake) the latest `effectiveFrom` wins, so a correction row inserted
 * on top of an old one takes effect without having to close the old row.
 */
export function selectPriceVersion<T extends PriceVersion>(versions: readonly T[], at: Date): T | undefined {
  const t = at.getTime();
  let best: T | undefined;
  for (const v of versions) {
    if (v.effectiveFrom.getTime() > t) continue;
    if (v.effectiveTo !== null && v.effectiveTo.getTime() <= t) continue;
    if (!best || v.effectiveFrom.getTime() > best.effectiveFrom.getTime()) best = v;
  }
  return best;
}
