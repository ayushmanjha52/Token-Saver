import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { decryptSecret, encryptSecret, KmsNotImplementedError, LocalKeyInProductionError } from "./crypto.js";

process.env.TOKENGRID_LOCAL_KEK = randomBytes(32).toString("base64");
const ctx = { orgId: "org-a", provider: "anthropic" };

test("round-trips under the same context", () => {
  const ct = encryptSecret("sk-ant-secret", ctx);
  assert.ok(!ct.includes("sk-ant-secret"));
  assert.equal(decryptSecret(ct, ctx), "sk-ant-secret");
});

test("a ciphertext moved to another org fails authentication", () => {
  const ct = encryptSecret("sk-ant-secret", ctx);
  assert.throws(() => decryptSecret(ct, { orgId: "org-b", provider: "anthropic" }));
});

test("local encryption refuses to run in production", () => {
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    assert.throws(() => encryptSecret("x", ctx), LocalKeyInProductionError);
  } finally {
    process.env.NODE_ENV = prev;
  }
});

test("the KMS path fails loudly until it is implemented", () => {
  assert.throws(() => decryptSecret("kms:v1:abc", ctx), KmsNotImplementedError);
});
