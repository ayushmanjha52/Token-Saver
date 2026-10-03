import type { PriceRates, PricingTier, Provider } from "@tokengrid/shared";

export interface CatalogPrice extends PriceRates {
  provider: Provider;
  providerModelId: string;
  tier: PricingTier;
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
const SOURCE = "Anthropic pricing via claude-api reference (cached 2026-09-25); verify at https://docs.anthropic.com/en/docs/about-claude/pricing";

function anthropic(
  providerModelId: string,
  input: string,
  output: string,
  cacheRead: string,
  cacheWrite5m: string,
  cacheWrite1h: string,
): CatalogPrice {
  return {
    provider: "anthropic",
    providerModelId,
    tier: "standard",
    effectiveFrom: CHECKED,
    source: SOURCE,
    inputPerMtok: input,
    outputPerMtok: output,
    cacheReadPerMtok: cacheRead,
    cacheWrite5mPerMtok: cacheWrite5m,
    cacheWrite1hPerMtok: cacheWrite1h,
  };
}

export const CATALOG: readonly CatalogPrice[] = [
  anthropic("claude-fable-5-1", "10", "50", "0.25", "12.50", "20"),
  anthropic("claude-fable-5", "10", "50", "1.00", "12.50", "20"),
  anthropic("claude-opus-5-5", "4", "20", "0.20", "5", "8"),
  anthropic("claude-opus-5", "5", "25", "0.50", "6.25", "10"),
  anthropic("claude-opus-4-8", "5", "25", "0.50", "6.25", "10"),
  anthropic("claude-opus-4-7", "5", "25", "0.50", "6.25", "10"),
  anthropic("claude-opus-4-6", "5", "25", "0.50", "6.25", "10"),
  anthropic("claude-sonnet-5-5", "2", "10", "0.20", "2.50", "4"),
  anthropic("claude-sonnet-5", "2", "10", "0.20", "2.50", "4"),
  anthropic("claude-sonnet-4-6", "3", "15", "0.30", "3.75", "6"),
  anthropic("claude-haiku-4-5", "1", "5", "0.10", "1.25", "2"),
];
