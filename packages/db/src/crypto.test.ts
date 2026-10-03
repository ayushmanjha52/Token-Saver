import { test } from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { decryptSecret, encryptSecret, KmsUnavailableError, LocalKeyInProductionError, setKmsClient, type KmsClientLike } from "./crypto.js";

process.env.TOKENGRID_LOCAL_KEK = randomBytes(32).toString("base64");
const ctx = { orgId: "org-a", provider: "anthropic" };

test("local: round-trips under the same context", async () => {
  const ct = await encryptSecret("sk-ant-secret", ctx);
  assert.ok(ct.startsWith("local:v1:") && !ct.includes("sk-ant-secret"));
  assert.equal(await decryptSecret(ct, ctx), "sk-ant-secret");
});

test("local: a ciphertext moved to another org fails authentication", async () => {
  const ct = await encryptSecret("sk-ant-secret", ctx);
  await assert.rejects(decryptSecret(ct, { orgId: "org-b", provider: "anthropic" }));
});

test("local encryption refuses to run in production", async () => {
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    await assert.rejects(encryptSecret("x", ctx), LocalKeyInProductionError);
  } finally {
    process.env.NODE_ENV = prev;
  }
});

/**
 * A KMS stand-in with KMS's contract: data keys are wrapped under a master
 * key, and unwrapping requires the exact encryption context used to wrap.
 */
function fakeKms(): KmsClientLike & { calls: string[] } {
  const master = randomBytes(32);
  const calls: string[] = [];
  const ctxKey = (c: Record<string, string>) => JSON.stringify(Object.entries(c).sort());
  return {
    calls,
    async generateDataKey(keyId, context) {
      calls.push(`generate:${keyId}`);
      const plaintext = randomBytes(32);
      const iv = randomBytes(12);
      const c = createCipheriv("aes-256-gcm", master, iv);
      c.setAAD(Buffer.from(ctxKey(context)));
      const wrapped = Buffer.concat([iv, c.update(plaintext), c.final(), c.getAuthTag()]);
      return { plaintext: Buffer.from(plaintext), encrypted: wrapped };
    },
    async decrypt(keyId, encrypted, context) {
      calls.push(`decrypt:${keyId}`);
      const b = Buffer.from(encrypted);
      const d = createDecipheriv("aes-256-gcm", master, b.subarray(0, 12));
      d.setAAD(Buffer.from(ctxKey(context)));
      d.setAuthTag(b.subarray(b.length - 16));
      return Buffer.concat([d.update(b.subarray(12, b.length - 16)), d.final()]);
    },
  };
}

test("kms: envelope round trip, and the stored value holds only the wrapped data key", async () => {
  const kms = fakeKms();
  setKmsClient(kms);
  process.env.TOKENGRID_KMS_KEY_ID = "arn:aws:kms:eu-west-1:111122223333:key/test";
  try {
    const ct = await encryptSecret("sk-ant-secret", ctx);
    assert.ok(ct.startsWith("kms:v1:") && !ct.includes("sk-ant-secret"));
    assert.equal(await decryptSecret(ct, ctx), "sk-ant-secret");
    assert.deepEqual(kms.calls, ["generate:arn:aws:kms:eu-west-1:111122223333:key/test", "decrypt:arn:aws:kms:eu-west-1:111122223333:key/test"]);
    // KMS itself refuses the data key for another org's context.
    await assert.rejects(decryptSecret(ct, { orgId: "org-b", provider: "anthropic" }), KmsUnavailableError);
  } finally {
    setKmsClient(null);
    delete process.env.TOKENGRID_KMS_KEY_ID;
  }
});

test("kms: works in production, where the local key is refused", async () => {
  setKmsClient(fakeKms());
  process.env.TOKENGRID_KMS_KEY_ID = "key";
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    assert.equal(await decryptSecret(await encryptSecret("s", ctx), ctx), "s");
  } finally {
    process.env.NODE_ENV = prev;
    setKmsClient(null);
    delete process.env.TOKENGRID_KMS_KEY_ID;
  }
});

test("kms: an unreachable KMS is a named error, not a crash", async () => {
  setKmsClient({
    generateDataKey: async () => {
      throw new Error("ECONNREFUSED");
    },
    decrypt: async () => {
      throw new Error("ECONNREFUSED");
    },
  });
  process.env.TOKENGRID_KMS_KEY_ID = "key";
  try {
    await assert.rejects(encryptSecret("s", ctx), KmsUnavailableError);
  } finally {
    setKmsClient(null);
    delete process.env.TOKENGRID_KMS_KEY_ID;
  }
});
