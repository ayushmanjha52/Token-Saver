import { InvalidUsageEventError } from "./errors.js";

/**
 * Provider-neutral token counts. Every field is disjoint from the others:
 * `inputTokens` never includes cached reads or cache writes, so cost is a
 * plain sum of field × rate and nothing downstream needs to know which
 * provider folds what into what.
 */
export interface NormalizedUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
}

export const PRICING_TIERS = ["standard", "fast"] as const;
export type PricingTier = (typeof PRICING_TIERS)[number];

export const PROVIDERS = ["anthropic"] as const;
export type Provider = (typeof PROVIDERS)[number];

/** Wire format of one entry on the usage Redis Stream. */
export interface UsageEventV1 {
  v: 1;
  provider: Provider;
  /**
   * The provider's own id for the call. It is the idempotency key, so it
   * must be identical however many times this payload is delivered.
   */
  providerRequestId: string;
  orgId: string;
  userId: string;
  virtualKeyId: string;
  /** The model the provider reports having served, not the one requested. */
  model: string;
  pricingTier: PricingTier;
  /** Gateway clock at request start; prices are resolved against this. */
  occurredAt: string;
  durationMs: number;
  httpStatus: number;
  streamed: boolean;
  /**
   * False when the response ended before the provider's final usage figure
   * arrived (client disconnect, upstream reset). Output tokens are then a
   * floor, not the billed amount; reconciliation uses this to explain drift.
   */
  usageComplete: boolean;
  stopReason: string | null;
  usage: NormalizedUsage;
  /**
   * Billable non-token units the catalog has no rate for (e.g. web search
   * requests). The worker refuses to price an event with any of these, since
   * the token cost alone would understate the bill.
   */
  unpricedUnits: Record<string, number>;
}

export function emptyUsage(): NormalizedUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWrite5mTokens: 0,
    cacheWrite1hTokens: 0,
  };
}

export function totalTokens(u: NormalizedUsage): number {
  return u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWrite5mTokens + u.cacheWrite1hTokens;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(o: Record<string, unknown>, k: string): string {
  const v = o[k];
  if (typeof v !== "string" || v.length === 0) throw new InvalidUsageEventError(`${k} must be a non-empty string`);
  return v;
}

function count(o: Record<string, unknown>, k: string): number {
  const v = o[k];
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) {
    throw new InvalidUsageEventError(`${k} must be a non-negative integer`);
  }
  return v;
}

function oneOf<T extends string>(o: Record<string, unknown>, k: string, allowed: readonly T[]): T {
  const v = o[k];
  if (typeof v !== "string" || !(allowed as readonly string[]).includes(v)) {
    throw new InvalidUsageEventError(`${k} must be one of ${allowed.join(", ")}`);
  }
  return v as T;
}

/**
 * Validates a stream payload. The worker treats anything that fails here as
 * poison and sends it to the DLQ rather than retrying it forever.
 */
export function parseUsageEvent(raw: string): UsageEventV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new InvalidUsageEventError("payload is not JSON");
  }
  if (!isRecord(parsed)) throw new InvalidUsageEventError("payload is not an object");
  if (parsed.v !== 1) throw new InvalidUsageEventError(`unsupported version ${String(parsed.v)}`);
  const u = parsed.usage;
  if (!isRecord(u)) throw new InvalidUsageEventError("usage must be an object");

  const occurredAt = str(parsed, "occurredAt");
  if (Number.isNaN(Date.parse(occurredAt))) throw new InvalidUsageEventError("occurredAt is not a timestamp");
  if (typeof parsed.streamed !== "boolean") throw new InvalidUsageEventError("streamed must be boolean");
  if (typeof parsed.usageComplete !== "boolean") throw new InvalidUsageEventError("usageComplete must be boolean");
  const stopReason = parsed.stopReason;
  if (stopReason !== null && typeof stopReason !== "string") {
    throw new InvalidUsageEventError("stopReason must be string or null");
  }
  const unpricedRaw = parsed.unpricedUnits;
  if (!isRecord(unpricedRaw)) throw new InvalidUsageEventError("unpricedUnits must be an object");
  const unpricedUnits: Record<string, number> = {};
  for (const k of Object.keys(unpricedRaw)) unpricedUnits[k] = count(unpricedRaw, k);

  return {
    v: 1,
    provider: oneOf(parsed, "provider", PROVIDERS),
    providerRequestId: str(parsed, "providerRequestId"),
    orgId: str(parsed, "orgId"),
    userId: str(parsed, "userId"),
    virtualKeyId: str(parsed, "virtualKeyId"),
    model: str(parsed, "model"),
    pricingTier: oneOf(parsed, "pricingTier", PRICING_TIERS),
    occurredAt,
    durationMs: count(parsed, "durationMs"),
    httpStatus: count(parsed, "httpStatus"),
    streamed: parsed.streamed,
    usageComplete: parsed.usageComplete,
    stopReason,
    usage: {
      inputTokens: count(u, "inputTokens"),
      outputTokens: count(u, "outputTokens"),
      cacheReadTokens: count(u, "cacheReadTokens"),
      cacheWrite5mTokens: count(u, "cacheWrite5mTokens"),
      cacheWrite1hTokens: count(u, "cacheWrite1hTokens"),
    },
    unpricedUnits,
  };
}
