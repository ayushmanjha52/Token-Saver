import { and, between, eq, gte, lte, ne, sql } from "drizzle-orm";
import { schema, type Database } from "@tokengrid/db";
import {
  COST_SCALE,
  computeCost,
  formatDecimal,
  isStructuralRetry,
  parseDecimal,
  RATE_SCALE,
  RETRY_WINDOW_MS,
  type PriceRates,
  type UsageEventV1,
} from "@tokengrid/shared";
import type { PriceCache } from "./prices.js";

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const LINT_WINDOW_MS = 7 * DAY_MS;
const MONTH_FACTOR = 30 / 7;
/** Prompt caching ignores prefixes below a model-dependent minimum (512–4096 tokens); 4096 never recommends an uncacheable prefix. */
export const MIN_CACHEABLE_PREFIX_TOKENS = 4096;
/** A cached prefix expires after five idle minutes; a request after a longer gap pays a fresh write. */
const CACHE_TTL_MS = 5 * 60_000;
export const PROMPT_FEATURE_RETENTION_DAYS = 35;

const pf = schema.promptFeatures;

function promptTokens(u: UsageEventV1["usage"]): number {
  return u.inputTokens + u.cacheReadTokens + u.cacheWrite5mTokens + u.cacheWrite1hTokens;
}

function hourOf(d: Date): Date {
  return new Date(Math.floor(d.getTime() / HOUR_MS) * HOUR_MS);
}

/**
 * Stores the request's prompt features and, if it pairs with a structurally
 * identical request in the same session within 15 minutes, records the
 * earlier of the two as discarded.
 *
 * Runs inside the ingest transaction, so the retry row and the waste added
 * to the discarded request's hourly rollup commit or roll back with the
 * event itself. Matching looks both ways in time because events from
 * concurrent gateways arrive out of order; whichever request ran first is
 * the one whose response was thrown away.
 */
export async function recordPromptAndDetectRetry(tx: Tx, event: UsageEventV1, costUsd: string): Promise<void> {
  const p = event.prompt;
  if (!p) return;
  const at = new Date(event.occurredAt);
  const u = event.usage;
  const prompt = promptTokens(u);
  await tx
    .insert(pf)
    .values({
      provider: event.provider,
      providerRequestId: event.providerRequestId,
      occurredAt: at,
      orgId: event.orgId,
      userId: event.userId,
      virtualKeyId: event.virtualKeyId,
      sessionKey: p.sessionKey,
      model: event.model,
      fingerprint: p.fingerprint,
      lastUserSimhash: p.lastUserSimhash,
      lastUserChars: p.lastUserChars,
      lastUserNumbers: p.lastUserNumbers,
      messageCount: p.messageCount,
      prefixHash: p.prefixHash,
      // Characters are measured, tokens are billed: scale the measured prompt
      // tokens by the prefix's share of characters rather than guess a ratio.
      prefixTokensEst: p.totalChars > 0 ? Math.round((prompt * p.prefixChars) / p.totalChars) : 0,
      hasSystem: p.hasSystem,
      hasFormatSpec: p.hasFormatSpec,
      usesCacheControl: p.usesCacheControl,
      inputTokens: u.inputTokens,
      outputTokens: u.outputTokens,
      cacheReadTokens: u.cacheReadTokens,
      cacheWriteTokens: u.cacheWrite5mTokens + u.cacheWrite1hTokens,
      costUsd,
    })
    .onConflictDoNothing();

  const candidates = await tx
    .select()
    .from(pf)
    .where(
      and(
        eq(pf.sessionKey, p.sessionKey),
        eq(pf.fingerprint, p.fingerprint),
        eq(pf.messageCount, p.messageCount),
        between(pf.occurredAt, new Date(at.getTime() - RETRY_WINDOW_MS), new Date(at.getTime() + RETRY_WINDOW_MS)),
        ne(pf.providerRequestId, event.providerRequestId),
      ),
    )
    .orderBy(sql`abs(extract(epoch from (${pf.occurredAt} - ${at.toISOString()}::timestamptz)))`)
    .limit(20);

  const self = {
    providerRequestId: event.providerRequestId,
    occurredAt: at,
    orgId: event.orgId,
    userId: event.userId,
    virtualKeyId: event.virtualKeyId,
    model: event.model,
    costUsd,
    tokens: prompt + u.outputTokens,
  };
  for (const c of candidates) {
    if (!isStructuralRetry(c, p)) continue;
    const other = {
      providerRequestId: c.providerRequestId,
      occurredAt: c.occurredAt,
      orgId: c.orgId,
      userId: c.userId,
      virtualKeyId: c.virtualKeyId,
      model: c.model,
      costUsd: c.costUsd,
      tokens: c.inputTokens + c.outputTokens + c.cacheReadTokens + c.cacheWriteTokens,
    };
    const [discarded, retry] = other.occurredAt.getTime() <= at.getTime() ? [other, self] : [self, other];
    const claimed = await tx
      .insert(schema.retries)
      .values({
        provider: event.provider,
        discardedRequestId: discarded.providerRequestId,
        retryRequestId: retry.providerRequestId,
        orgId: discarded.orgId,
        userId: discarded.userId,
        discardedAt: discarded.occurredAt,
        wastedCostUsd: discarded.costUsd,
        wastedTokens: discarded.tokens,
      })
      .onConflictDoNothing()
      .returning({ id: schema.retries.discardedRequestId });
    // Already counted as discarded by an earlier pairing: try the next candidate.
    if (claimed.length === 0) continue;
    const r = schema.usageRollupHourly;
    await tx
      .update(r)
      .set({
        retriedRequests: sql`${r.retriedRequests} + 1`,
        wastedCostUsd: sql`${r.wastedCostUsd} + ${discarded.costUsd}::numeric`,
      })
      .where(
        and(
          eq(r.bucketStart, hourOf(discarded.occurredAt)),
          eq(r.orgId, discarded.orgId),
          eq(r.userId, discarded.userId),
          eq(r.virtualKeyId, discarded.virtualKeyId),
          eq(r.provider, event.provider),
          eq(r.model, discarded.model),
        ),
      );
    return;
  }
}

// ---------------------------------------------------------------- lint

export const LINT_RULES = [
  "uncached_prefix",
  "model_overspec",
  "missing_format_spec",
  "large_context_short_answer",
  "missing_system_prompt",
] as const;
export type LintRule = (typeof LINT_RULES)[number];

type FeatureRow = typeof pf.$inferSelect;

function usd(pico: bigint): number {
  return Number(formatDecimal(pico, COST_SCALE));
}

function rate(r: string): bigint {
  return parseDecimal(r, RATE_SCALE);
}

/** tokens × $/MTok rate, in pico-dollars. */
function tokCost(tokens: number, ratePerMtok: string): bigint {
  return BigInt(Math.max(0, Math.round(tokens))) * rate(ratePerMtok);
}

function rowUsage(r: FeatureRow) {
  // The 5m/1h split is not kept per feature row; pricing writes at the 5m
  // rate understates their cost, which only makes savings more conservative.
  return { inputTokens: r.inputTokens, outputTokens: r.outputTokens, cacheReadTokens: r.cacheReadTokens, cacheWrite5mTokens: r.cacheWriteTokens, cacheWrite1hTokens: 0 };
}

interface RuleResult {
  atStakePico: bigint;
  /** Null when no saving can be computed from prices alone. */
  savingsPico: bigint | null;
  detail: Record<string, string | number>;
}

/** Which rules a single request trips. Pure, so it is cheap to run on every event. */
export function matchingRules(r: FeatureRow, modelTier: string | undefined, hasCheaperTier: boolean): LintRule[] {
  const prompt = r.inputTokens + r.cacheReadTokens + r.cacheWriteTokens;
  const out: LintRule[] = [];
  if (r.prefixHash && !r.usesCacheControl && r.cacheReadTokens === 0 && r.prefixTokensEst >= MIN_CACHEABLE_PREFIX_TOKENS) {
    out.push("uncached_prefix");
  }
  if (modelTier === "frontier" && hasCheaperTier && r.outputTokens <= 300 && prompt <= 4000) out.push("model_overspec");
  if (!r.hasFormatSpec && r.outputTokens >= 1000) out.push("missing_format_spec");
  if (prompt >= 30_000 && r.outputTokens <= 400) out.push("large_context_short_answer");
  if (!r.hasSystem) out.push("missing_system_prompt");
  return out;
}

async function priceAt(prices: PriceCache, r: FeatureRow): Promise<PriceRates> {
  return prices.resolve(r.provider, r.model, "standard", r.occurredAt);
}

async function evaluateRule(rule: LintRule, rows: FeatureRow[], prices: PriceCache): Promise<RuleResult | null> {
  let atStake = 0n;
  let savings: bigint | null = null;
  const detail: Record<string, string | number> = {};

  switch (rule) {
    case "uncached_prefix": {
      // Savings: every request reads the prefix at the cache-read rate instead
      // of the input rate, minus the write premium each time the cache would
      // have gone cold (first request, and after every gap over 5 minutes).
      savings = 0n;
      let prev: Date | null = null;
      for (const r of [...rows].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime())) {
        const p = await priceAt(prices, r);
        atStake += tokCost(r.prefixTokensEst, p.inputPerMtok);
        savings += tokCost(r.prefixTokensEst, p.inputPerMtok) - tokCost(r.prefixTokensEst, p.cacheReadPerMtok);
        if (!prev || r.occurredAt.getTime() - prev.getTime() > CACHE_TTL_MS) {
          savings -= tokCost(r.prefixTokensEst, p.cacheWrite5mPerMtok) - tokCost(r.prefixTokensEst, p.inputPerMtok);
        }
        prev = r.occurredAt;
      }
      if (savings <= 0n) return null;
      detail.prefixTokens = Math.round(rows.reduce((a, r) => a + r.prefixTokensEst, 0) / rows.length);
      break;
    }
    case "model_overspec": {
      const first = rows[0];
      if (!first) return null;
      const alt = prices.cheapestInTier(first.provider, "balanced", first.occurredAt);
      if (!alt) return null;
      savings = 0n;
      for (const r of rows) {
        const cost = parseDecimal(r.costUsd, COST_SCALE);
        atStake += cost;
        savings += cost - computeCost(rowUsage(r), alt.price).totalPico;
      }
      if (savings <= 0n) return null;
      detail.suggestedModel = alt.model;
      break;
    }
    case "missing_format_spec":
      for (const r of rows) atStake += tokCost(r.outputTokens, (await priceAt(prices, r)).outputPerMtok);
      detail.avgOutputTokens = Math.round(rows.reduce((a, r) => a + r.outputTokens, 0) / rows.length);
      break;
    case "large_context_short_answer":
      for (const r of rows) {
        const p = await priceAt(prices, r);
        atStake += tokCost(r.inputTokens, p.inputPerMtok) + tokCost(r.cacheReadTokens, p.cacheReadPerMtok) + tokCost(r.cacheWriteTokens, p.cacheWrite5mPerMtok);
      }
      detail.avgPromptTokens = Math.round(rows.reduce((a, r) => a + r.inputTokens + r.cacheReadTokens + r.cacheWriteTokens, 0) / rows.length);
      break;
    case "missing_system_prompt":
      // Only a repeated workflow is worth a reusable system prompt.
      if (rows.length < 5) return null;
      for (const r of rows) atStake += parseDecimal(r.costUsd, COST_SCALE);
      break;
  }
  return { atStakePico: atStake, savingsPico: savings, detail };
}

/**
 * Runs the static lint rules for one freshly ingested request and refreshes
 * the findings it touches. Each figure is that person's trailing-7-day spend
 * on the matching requests, scaled to 30 days. Best effort: findings are
 * derived data and are rebuilt by the next matching request.
 */
export async function lintRequest(db: Database, prices: PriceCache, event: UsageEventV1, now = new Date()): Promise<void> {
  if (!event.prompt) return;
  const [row] = await db
    .select()
    .from(pf)
    .where(and(eq(pf.provider, event.provider), eq(pf.providerRequestId, event.providerRequestId)));
  if (!row) return;
  const tier = prices.modelTier(row.provider, row.model);
  const hasCheaper = prices.cheapestInTier(row.provider, "balanced", row.occurredAt) !== null;
  const rules = matchingRules(row, tier, hasCheaper);
  if (rules.length === 0) return;

  await db
    .update(pf)
    // Passed as a Postgres array literal: Drizzle binds a JS array as a bare
    // string, which ::text[] rejects. Rule ids are fixed identifiers, no quoting needed.
    .set({ flags: sql`(select array(select distinct unnest(${pf.flags} || ${`{${rules.join(",")}}`}::text[])))` })
    .where(and(eq(pf.provider, row.provider), eq(pf.providerRequestId, row.providerRequestId)));

  // The window ends now, not at this event: findings describe current
  // habits, and an event redelivered or redriven late would otherwise
  // re-evaluate a stale week and overwrite the finding with an undercount.
  const end = now;
  const start = new Date(end.getTime() - LINT_WINDOW_MS);
  for (const rule of rules) {
    const groupKey = rule === "uncached_prefix" ? row.prefixHash : row.fingerprint;
    if (!groupKey) continue;
    const groupCol = rule === "uncached_prefix" ? pf.prefixHash : pf.fingerprint;
    const rows = await db
      .select()
      .from(pf)
      .where(
        and(
          eq(pf.userId, row.userId),
          eq(groupCol, groupKey),
          gte(pf.occurredAt, start),
          lte(pf.occurredAt, end),
          sql`${rule} = any(${pf.flags})`,
        ),
      );
    if (rows.length === 0) continue;
    const result = await evaluateRule(rule, rows, prices);
    const table = schema.lintFindings;
    if (!result || result.atStakePico < 10_000_000_000n) {
      // Under a cent a month, or no longer saves anything: not worth anyone's attention.
      await db.delete(table).where(and(eq(table.userId, row.userId), eq(table.rule, rule), eq(table.groupKey, groupKey)));
      continue;
    }
    const monthly = (pico: bigint) => (usd(pico) * MONTH_FACTOR).toFixed(4);
    const times = rows.map((r) => r.occurredAt.getTime());
    const values = {
      orgId: row.orgId,
      userId: row.userId,
      rule,
      groupKey,
      model: row.model,
      requests7d: rows.length,
      monthlyAtStakeUsd: monthly(result.atStakePico),
      monthlySavingsUsd: result.savingsPico === null ? null : monthly(result.savingsPico),
      detail: result.detail,
      firstSeen: new Date(Math.min(...times)),
      lastSeen: new Date(Math.max(...times)),
    };
    await db
      .insert(table)
      .values(values)
      .onConflictDoUpdate({ target: [table.userId, table.rule, table.groupKey], set: { ...values, firstSeen: sql`least(${table.firstSeen}, excluded.first_seen)` } });
  }
}

// ---------------------------------------------------------------- score

/**
 * Base weights. Acceptance has the strongest claim to measure outcome, but
 * nothing reports it yet; until it does its weight is redistributed rather
 * than scored as a failure.
 */
export const SCORE_WEIGHTS = { retry: 0.35, modelFit: 0.25, cache: 0.2, acceptance: 0.2 } as const;
export const SCORE_WINDOW_DAYS = 7;

export interface ScoreComponents {
  requests: number;
  /** Share of requests that were re-sent. */
  retryRate: number | null;
  /** Share of spend not flagged as over-specified model tier. */
  modelFit: number | null;
  /** Share of cacheable prefix tokens served from cache. */
  cacheHitRate: number | null;
  acceptanceRate: number | null;
  weights: { retry: number; modelFit: number; cache: number; acceptance: number };
  score: number | null;
}

export function combineScore(c: Omit<ScoreComponents, "weights" | "score">): Pick<ScoreComponents, "weights" | "score"> {
  const parts = {
    retry: c.retryRate === null ? null : 1 - c.retryRate,
    modelFit: c.modelFit,
    cache: c.cacheHitRate,
    acceptance: c.acceptanceRate,
  };
  const present = (Object.keys(parts) as (keyof typeof parts)[]).filter((k) => parts[k] !== null);
  const total = present.reduce((a, k) => a + SCORE_WEIGHTS[k], 0);
  const weights = { retry: 0, modelFit: 0, cache: 0, acceptance: 0 };
  if (total === 0) return { weights, score: null };
  let score = 0;
  for (const k of present) {
    weights[k] = SCORE_WEIGHTS[k] / total;
    score += weights[k] * (parts[k] ?? 0);
  }
  return { weights, score: Math.round(score * 10_000) / 100 };
}

export async function computeScore(db: Database, userId: string, asOf: Date): Promise<ScoreComponents> {
  const start = new Date(asOf.getTime() - SCORE_WINDOW_DAYS * DAY_MS);
  const r = schema.usageRollupHourly;
  const [roll] = await db
    .select({
      requests: sql<number>`coalesce(sum(${r.requests}), 0)::int`,
      retried: sql<number>`coalesce(sum(${r.retriedRequests}), 0)::int`,
    })
    .from(r)
    .where(and(eq(r.userId, userId), gte(r.bucketStart, hourOf(start)), lte(r.bucketStart, asOf)));
  const [feat] = await db
    .select({
      n: sql<number>`count(*)::int`,
      spend: sql<string>`coalesce(sum(${pf.costUsd}), 0)::text`,
      overspecSpend: sql<string>`coalesce(sum(${pf.costUsd}) filter (where 'model_overspec' = any(${pf.flags})), 0)::text`,
      cacheablePrefix: sql<number>`coalesce(sum(${pf.prefixTokensEst}) filter (where ${pf.prefixTokensEst} >= ${MIN_CACHEABLE_PREFIX_TOKENS}), 0)::float8`,
      cachedPrefix: sql<number>`coalesce(sum(least(${pf.cacheReadTokens}, ${pf.prefixTokensEst})) filter (where ${pf.prefixTokensEst} >= ${MIN_CACHEABLE_PREFIX_TOKENS}), 0)::float8`,
    })
    .from(pf)
    .where(and(eq(pf.userId, userId), gte(pf.occurredAt, start), lte(pf.occurredAt, asOf)));

  const requests = roll?.requests ?? 0;
  const spend = Number(feat?.spend ?? 0);
  const components = {
    requests,
    retryRate: requests > 0 ? Math.min(1, (roll?.retried ?? 0) / requests) : null,
    modelFit: feat && feat.n > 0 && spend > 0 ? 1 - Number(feat.overspecSpend) / spend : null,
    cacheHitRate: feat && feat.cacheablePrefix > 0 ? feat.cachedPrefix / feat.cacheablePrefix : null,
    acceptanceRate: null,
  };
  return { ...components, ...combineScore(components) };
}

export async function storeScore(db: Database, userId: string, orgId: string, asOf: Date): Promise<ScoreComponents> {
  const c = await computeScore(db, userId, asOf);
  const fixed = (v: number | null, d: number) => (v === null ? null : v.toFixed(d));
  const values = {
    userId,
    orgId,
    asOfDay: asOf.toISOString().slice(0, 10),
    windowDays: SCORE_WINDOW_DAYS,
    requests: c.requests,
    retryRate: fixed(c.retryRate, 5),
    modelFit: fixed(c.modelFit, 5),
    cacheHitRate: fixed(c.cacheHitRate, 5),
    acceptanceRate: fixed(c.acceptanceRate, 5),
    weightRetry: c.weights.retry.toFixed(3),
    weightModelFit: c.weights.modelFit.toFixed(3),
    weightCache: c.weights.cache.toFixed(3),
    weightAcceptance: c.weights.acceptance.toFixed(3),
    score: fixed(c.score, 2),
    computedAt: new Date(),
  };
  const t = schema.efficiencyScores;
  await db.insert(t).values(values).onConflictDoUpdate({ target: [t.userId, t.asOfDay], set: values });
  return c;
}

export async function pruneFeatures(db: Database, now = new Date()): Promise<void> {
  await db.delete(pf).where(sql`${pf.occurredAt} < ${new Date(now.getTime() - PROMPT_FEATURE_RETENTION_DAYS * DAY_MS).toISOString()}::timestamptz`);
}
