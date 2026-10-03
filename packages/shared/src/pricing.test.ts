import { test } from "node:test";
import assert from "node:assert/strict";
import { computeCost, formatDecimal, parseDecimal, selectPriceVersion, type PriceVersion } from "./pricing.js";
import { InvalidDecimalError } from "./errors.js";

const opus55 = {
  inputPerMtok: "4",
  outputPerMtok: "20",
  cacheReadPerMtok: "0.20",
  cacheWrite5mPerMtok: "5",
  cacheWrite1hPerMtok: "8",
};

test("cost is exact to the pico-dollar", () => {
  const c = computeCost(
    { inputTokens: 1234, outputTokens: 567, cacheReadTokens: 40_000, cacheWrite5mTokens: 3, cacheWrite1hTokens: 0 },
    opus55,
  );
  // (1234×4 + 567×20 + 40000×0.2 + 3×5) / 1e6 = 24291 / 1e6 = $0.024291
  assert.equal(c.costUsd, "0.024291000000");
});

test("a rate that is not representable in binary float still sums exactly", () => {
  const rates = { ...opus55, inputPerMtok: "0.1" };
  let total = 0n;
  for (let i = 0; i < 1000; i++) {
    total += computeCost(
      { inputTokens: 3, outputTokens: 0, cacheReadTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0 },
      rates,
    ).totalPico;
  }
  assert.equal(formatDecimal(total, 12), "0.000300000000");
});

test("parseDecimal rejects excess precision instead of rounding", () => {
  assert.equal(parseDecimal("12.50", 6), 12_500_000n);
  assert.equal(parseDecimal("0.000001", 6), 1n);
  assert.throws(() => parseDecimal("0.0000001", 6), InvalidDecimalError);
  assert.throws(() => parseDecimal("-1", 6), InvalidDecimalError);
});

test("price lookup uses the event time, not now", () => {
  const v1: PriceVersion = { id: "v1", ...opus55, effectiveFrom: new Date("2026-01-01T00:00:00Z"), effectiveTo: new Date("2026-10-01T00:00:00Z") };
  const v2: PriceVersion = { id: "v2", ...opus55, inputPerMtok: "3", effectiveFrom: new Date("2026-10-01T00:00:00Z"), effectiveTo: null };
  assert.equal(selectPriceVersion([v1, v2], new Date("2026-09-30T23:59:59.999Z"))?.id, "v1");
  assert.equal(selectPriceVersion([v1, v2], new Date("2026-10-01T00:00:00Z"))?.id, "v2");
  assert.equal(selectPriceVersion([v1, v2], new Date("2025-12-31T00:00:00Z")), undefined);
});
