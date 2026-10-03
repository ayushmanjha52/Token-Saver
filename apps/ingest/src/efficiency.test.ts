import { test } from "node:test";
import assert from "node:assert/strict";
import { combineScore, matchingRules, MIN_CACHEABLE_PREFIX_TOKENS } from "./efficiency.js";

test("a component with no signal gives its weight to the others instead of scoring zero", () => {
  const r = combineScore({ requests: 10, retryRate: 0, modelFit: 1, cacheHitRate: null, acceptanceRate: null });
  assert.equal(r.score, 100);
  assert.equal(r.weights.acceptance, 0);
  assert.equal(r.weights.cache, 0);
  assert.ok(Math.abs(r.weights.retry + r.weights.modelFit - 1) < 1e-9);
});

test("retries lower the score in proportion to their weight", () => {
  const clean = combineScore({ requests: 3, retryRate: 0, modelFit: 1, cacheHitRate: null, acceptanceRate: null });
  const twoRetries = combineScore({ requests: 3, retryRate: 2 / 3, modelFit: 1, cacheHitRate: null, acceptanceRate: null });
  assert.ok((twoRetries.score ?? 100) < (clean.score ?? 0));
  // retry carries 0.35 / 0.60 of the weight: 100 - 58.33 × 2/3
  assert.equal(twoRetries.score, 61.11);
});

test("no measured components: no score at all", () => {
  assert.equal(combineScore({ requests: 0, retryRate: null, modelFit: null, cacheHitRate: null, acceptanceRate: null }).score, null);
});

const base = {
  provider: "anthropic",
  providerRequestId: "r",
  occurredAt: new Date(),
  orgId: "o",
  userId: "u",
  virtualKeyId: "k",
  sessionKey: "s",
  model: "claude-opus-5-5",
  fingerprint: "f",
  lastUserSimhash: "0".repeat(16),
  lastUserChars: 20,
  lastUserNumbers: "0".repeat(32),
  messageCount: 1,
  prefixHash: "p",
  prefixTokensEst: 0,
  hasSystem: true,
  hasFormatSpec: true,
  usesCacheControl: false,
  inputTokens: 500,
  outputTokens: 500,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: "0.01",
  flags: [],
};

test("lint rules match on measured shape only", () => {
  assert.deepEqual(matchingRules(base, "balanced", true), []);
  assert.deepEqual(matchingRules({ ...base, prefixTokensEst: MIN_CACHEABLE_PREFIX_TOKENS, inputTokens: 12_000 }, "balanced", true), ["uncached_prefix"]);
  assert.deepEqual(matchingRules({ ...base, prefixTokensEst: MIN_CACHEABLE_PREFIX_TOKENS, cacheReadTokens: 4096 }, "balanced", true), []);
  assert.deepEqual(matchingRules({ ...base, outputTokens: 120 }, "frontier", true), ["model_overspec"]);
  assert.deepEqual(matchingRules({ ...base, outputTokens: 120 }, "frontier", false), []);
  assert.deepEqual(matchingRules({ ...base, hasFormatSpec: false, outputTokens: 1500 }, "balanced", true), ["missing_format_spec"]);
  assert.deepEqual(matchingRules({ ...base, inputTokens: 40_000, outputTokens: 100 }, "balanced", true), ["large_context_short_answer"]);
  assert.deepEqual(matchingRules({ ...base, hasSystem: false }, "balanced", true), ["missing_system_prompt"]);
});
