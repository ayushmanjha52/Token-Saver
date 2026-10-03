import { test } from "node:test";
import assert from "node:assert/strict";
import { fingerprint, hammingHex64, isStructuralRetry, normalizePrompt, numbersDigest, simhash64 } from "./prompt.js";

test("normalisation: lowercase, digits to #, punctuation gone, whitespace collapsed", () => {
  assert.equal(normalizePrompt("  Order #1234 —  SHIPPED!\n\tCheck it? "), "order #### shipped check it");
});

test("templated prompts that differ only in digits or punctuation share a fingerprint", () => {
  assert.equal(fingerprint("Summarise ticket 1182."), fingerprint("summarise TICKET 9907"));
  assert.notEqual(fingerprint("Summarise ticket 1182"), fingerprint("Close ticket 1182"));
});

test("simhash: a light rewording stays close, a different question does not", () => {
  const base = "please explain how the substation meters every feeder on one shared scale so operators read load at a glance";
  const reworded = "please explain how the substation meters each feeder on one shared scale so operators read load at a glance";
  const other = "write a haiku about rain falling on a tin roof in late autumn while the kettle boils";
  assert.ok(hammingHex64(simhash64(base), simhash64(base)) === 0);
  assert.ok(hammingHex64(simhash64(base), simhash64(reworded)) < hammingHex64(simhash64(base), simhash64(other)));
  assert.ok(hammingHex64(simhash64(base), simhash64(other)) > 3);
});

test("structural retry needs fingerprint, shape and final turn to match", () => {
  const a = { fingerprint: "f", lastUserSimhash: simhash64("what is the capital of france"), lastUserChars: 30, lastUserNumbers: numbersDigest("x"), messageCount: 1 };
  assert.ok(isStructuralRetry(a, { ...a }));
  assert.ok(!isStructuralRetry(a, { ...a, messageCount: 3 }));
  assert.ok(!isStructuralRetry(a, { ...a, lastUserChars: 60 }));
  assert.ok(!isStructuralRetry(a, { ...a, lastUserSimhash: simhash64("tell me a long story about dragons and castles") }));
  assert.ok(!isStructuralRetry(a, { ...a, fingerprint: "g" }));
  // Same template, different numbers: a different question, not a resend.
  assert.ok(!isStructuralRetry({ ...a, lastUserNumbers: numbersDigest("feeder 7") }, { ...a, lastUserNumbers: numbersDigest("feeder 14") }));
});
