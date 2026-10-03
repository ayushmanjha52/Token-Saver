import { test } from "node:test";
import assert from "node:assert/strict";
import { niceCeil } from "./format.js";
import { parseUsageQuery, periodRange, pseudonym, UsageAccessError } from "./usage.js";

test("periods end at the end of today (UTC) and month starts on the 1st", () => {
  const now = new Date("2026-10-03T15:00:00Z");
  assert.deepEqual(periodRange("7d", now), { start: new Date("2026-09-27T00:00:00Z"), end: new Date("2026-10-04T00:00:00Z") });
  assert.equal(periodRange("month", now).start.toISOString(), "2026-10-01T00:00:00.000Z");
});

test("pseudonyms are stable within a period and unlinkable across periods", () => {
  const a = pseudonym("s", "team", "30d", new Date("2026-09-04T00:00:00Z"), "user");
  assert.equal(a, pseudonym("s", "team", "30d", new Date("2026-09-04T00:00:00Z"), "user"));
  assert.notEqual(a, pseudonym("s", "team", "30d", new Date("2026-09-05T00:00:00Z"), "user"));
  assert.ok(!a.includes("user"));
});

test("query validation", () => {
  assert.deepEqual(parseUsageQuery(new URLSearchParams("")), { view: "self", period: "30d" });
  assert.throws(() => parseUsageQuery(new URLSearchParams("view=everyone")), UsageAccessError);
  assert.throws(() => parseUsageQuery(new URLSearchParams("period=1y")), UsageAccessError);
});

test("scale maxima land on readable numbers", () => {
  assert.deepEqual([0, 0.7, 1.79, 3.09, 10.76, 41].map(niceCeil), [1, 1, 2, 5, 20, 50]);
});
