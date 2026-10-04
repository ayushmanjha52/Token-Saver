import type { PriceRates, PricingTier, Provider } from "@tokengrid/shared";

export type ModelTier = "frontier" | "balanced" | "fast";

export interface CatalogPrice extends PriceRates {
  provider: Provider;
  providerModelId: string;
  tier: ModelTier;
  pricingTier: PricingTier;
  effectiveFrom: string;
  source: string;
}

/**
 * Anthropic first-party list prices in USD per million tokens.
 *
 * effective_from is the date these figures were last checked, not the
 * model's launch date: we can only vouch for a price from the day we read
 * it. An event older than that goes to the DLQ instead of being priced on a
 * guess.
 *
 * Cache-read rates are stored per model rather than derived as 0.1x input
 * because they diverge (Opus 5.5 is 0.05x, Fable 5.1 is 0.025x).
 *
 * Fast-mode rows are deliberately absent: the published fast rates cover
 * input and output only, and inventing cache rates would misprice cached
 * fast requests. A fast-mode event goes to the DLQ until verified rows exist.
 */
const CHECKED = "2026-09-25T00:00:00Z";
const SOURCE = "https://www.anthropic.com/pricing, checked 2026-09-25";

function anthropic(
  providerModelId: string,
  tier: ModelTier,
  input: string,
  output: string,
  cacheRead: string,
  cacheWrite5m: string,
  cacheWrite1h: string,
): CatalogPrice {
  return {
    provider: "anthropic",
    providerModelId,
    tier,
    pricingTier: "standard",
    effectiveFrom: CHECKED,
    source: SOURCE,
    inputPerMtok: input,
    outputPerMtok: output,
    cacheReadPerMtok: cacheRead,
    cacheWrite5mPerMtok: cacheWrite5m,
    cacheWrite1hPerMtok: cacheWrite1h,
  };
}

/**
 * OpenAI list prices, read from the pricing page on 2026-10-03. Only models
 * whose every rate (input, cached input, cache write, output) was confirmed
 * on the page are seeded; the rest go to the DLQ until someone adds verified
 * rows, rather than being priced with a guessed cache-write rate. OpenAI has
 * one cache-write rate, stored in both write slots; the adapter only ever
 * fills the 5-minute slot. Long-context (>272K) rates are not seeded, so
 * long-context calls wait in the DLQ too.
 */
const OPENAI_CHECKED = "2026-10-03T00:00:00Z";
const OPENAI_SOURCE = "https://developers.openai.com/api/docs/pricing (Standard, short context), read 2026-10-03";

function openai(providerModelId: string, tier: ModelTier, input: string, cachedInput: string, cacheWrite: string, output: string): CatalogPrice {
  return {
    provider: "openai",
    providerModelId,
    tier,
    pricingTier: "standard",
    effectiveFrom: OPENAI_CHECKED,
    source: OPENAI_SOURCE,
    inputPerMtok: input,
    outputPerMtok: output,
    cacheReadPerMtok: cachedInput,
    cacheWrite5mPerMtok: cacheWrite,
    cacheWrite1hPerMtok: cacheWrite,
  };
}

export const CATALOG: readonly CatalogPrice[] = [
  openai("gpt-6-astra", "frontier", "10.00", "1.00", "12.50", "50.00"),
  openai("gpt-5.6-sol", "frontier", "4.00", "0.40", "5.00", "20.00"),
  openai("gpt-6.1-sol", "balanced", "2.00", "0.10", "2.50", "10.00"),
  openai("gpt-6-sol", "balanced", "2.00", "0.20", "2.50", "10.00"),
  openai("gpt-5.6-terra", "balanced", "2.00", "0.20", "2.50", "12.00"),
  openai("gpt-6-luna", "fast", "0.10", "0.01", "0.125", "0.50"),
  openai("gpt-5.6-luna", "fast", "0.20", "0.02", "0.25", "1.20"),
  anthropic("claude-fable-5-1", "frontier", "10", "50", "0.25", "12.50", "20"),
  anthropic("claude-fable-5", "frontier", "10", "50", "1.00", "12.50", "20"),
  anthropic("claude-opus-5-5", "frontier", "4", "20", "0.20", "5", "8"),
  anthropic("claude-opus-5", "frontier", "5", "25", "0.50", "6.25", "10"),
  anthropic("claude-opus-4-8", "frontier", "5", "25", "0.50", "6.25", "10"),
  anthropic("claude-opus-4-7", "frontier", "5", "25", "0.50", "6.25", "10"),
  anthropic("claude-opus-4-6", "frontier", "5", "25", "0.50", "6.25", "10"),
  anthropic("claude-sonnet-5-5", "balanced", "2", "10", "0.20", "2.50", "4"),
  anthropic("claude-sonnet-5", "balanced", "2", "10", "0.20", "2.50", "4"),
  anthropic("claude-sonnet-4-6", "balanced", "3", "15", "0.30", "3.75", "6"),
  anthropic("claude-haiku-4-5", "fast", "1", "5", "0.10", "1.25", "2"),
];
