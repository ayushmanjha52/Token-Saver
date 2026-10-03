import { test } from "node:test";
import assert from "node:assert/strict";
import { classify } from "./reconcile.js";

test("5% under-metering on a small day is drift", () => {
  const r = classify(0.17, 0.1615);
  assert.equal(r.status, "drift");
  assert.ok(r.driftRatio !== null && Math.abs(r.driftRatio + 0.05) < 1e-9);
});

test("within 2% is ok in either direction", () => {
  assert.equal(classify(100, 101.9).status, "ok");
  assert.equal(classify(100, 98.1).status, "ok");
  assert.equal(classify(100, 102.1).status, "drift");
});

test("sub-tenth-of-a-cent differences are noise, however large the ratio", () => {
  assert.equal(classify(0.0004, 0.0009).status, "ok");
});

test("metered spend the provider never billed is drift with no ratio", () => {
  assert.deepEqual(classify(0, 0.5), { driftRatio: null, status: "drift" });
  assert.deepEqual(classify(0, 0), { driftRatio: null, status: "ok" });
});
