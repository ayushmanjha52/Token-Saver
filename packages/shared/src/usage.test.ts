import { test } from "node:test";
import assert from "node:assert/strict";
import { parseUsageEvent, type UsageEventV1 } from "./usage.js";
import { InvalidUsageEventError } from "./errors.js";

const valid: UsageEventV1 = {
  v: 1,
  provider: "anthropic",
  providerRequestId: "req_1",
  orgId: "o",
  userId: "u",
  virtualKeyId: "k",
  model: "claude-opus-5-5",
  pricingTier: "standard",
  occurredAt: "2026-10-03T12:00:00.000Z",
  durationMs: 1200,
  httpStatus: 200,
  streamed: true,
  usageComplete: true,
  stopReason: "end_turn",
  usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWrite5mTokens: 4, cacheWrite1hTokens: 5 },
  unpricedUnits: {},
};

test("round-trips a valid event", () => {
  assert.deepEqual(parseUsageEvent(JSON.stringify(valid)), valid);
});

test("rejects negative or fractional token counts", () => {
  for (const bad of [-1, 1.5, "3"]) {
    const e = { ...valid, usage: { ...valid.usage, outputTokens: bad } };
    assert.throws(() => parseUsageEvent(JSON.stringify(e)), InvalidUsageEventError);
  }
});

test("rejects unknown providers and tiers", () => {
  assert.throws(() => parseUsageEvent(JSON.stringify({ ...valid, provider: "chatgpt-plus" })), InvalidUsageEventError);
  assert.throws(() => parseUsageEvent(JSON.stringify({ ...valid, pricingTier: "batch" })), InvalidUsageEventError);
});

test("rejects garbage", () => {
  assert.throws(() => parseUsageEvent("not json"), InvalidUsageEventError);
  assert.throws(() => parseUsageEvent("[]"), InvalidUsageEventError);
});
