import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export class LocalKeyInProductionError extends Error {
  override readonly name = "LocalKeyInProductionError";
  constructor() {
    super(
      "Local envelope encryption is disabled when NODE_ENV=production. " +
        "Set TOKENGRID_KMS_KEY_ID and implement the KMS path in packages/db/src/crypto.ts (Stage 6).",
    );
  }
}

export class KmsNotImplementedError extends Error {
  override readonly name = "KmsNotImplementedError";
  constructor(op: "encrypt" | "decrypt") {
    super(
      `KMS ${op} is not implemented yet (Stage 6). It needs a cloud KMS client that wraps a per-secret ` +
        "data key under TOKENGRID_KMS_KEY_ID. Unset TOKENGRID_KMS_KEY_ID to use the local development key.",
    );
  }
}

export class MissingLocalKekError extends Error {
  override readonly name = "MissingLocalKekError";
  constructor() {
    super("TOKENGRID_LOCAL_KEK must be 32 random bytes, base64-encoded. See .env.example.");
  }
}

export class CiphertextFormatError extends Error {
  override readonly name = "CiphertextFormatError";
  constructor(reason: string) {
    super(`Stored ciphertext is malformed: ${reason}`);
  }
}

/** Identifies what a ciphertext protects; mixed into GCM's AAD. */
export interface SecretContext {
  orgId: string;
  provider: string;
}

const LOCAL_PREFIX = "local:v1:";
const KMS_PREFIX = "kms:v1:";

function localKek(): Buffer {
  if (process.env.NODE_ENV === "production") throw new LocalKeyInProductionError();
  const raw = process.env.TOKENGRID_LOCAL_KEK;
  if (!raw) throw new MissingLocalKekError();
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) throw new MissingLocalKekError();
  return key;
}

/**
 * Binding the ciphertext to its org and provider means a row copied into
 * another org's credential slot fails authentication instead of silently
 * billing the wrong customer's upstream account.
 */
function aad(ctx: SecretContext): Buffer {
  return Buffer.from(`tokengrid:${ctx.orgId}:${ctx.provider}`, "utf8");
}

export function encryptSecret(plaintext: string, ctx: SecretContext): string {
  if (process.env.TOKENGRID_KMS_KEY_ID) throw new KmsNotImplementedError("encrypt");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", localKek(), iv);
  cipher.setAAD(aad(ctx));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${LOCAL_PREFIX}${iv.toString("base64")}:${tag.toString("base64")}:${ct.toString("base64")}`;
}

export function decryptSecret(stored: string, ctx: SecretContext): string {
  if (stored.startsWith(KMS_PREFIX)) throw new KmsNotImplementedError("decrypt");
  if (!stored.startsWith(LOCAL_PREFIX)) throw new CiphertextFormatError("unknown scheme prefix");
  const [ivB64, tagB64, ctB64] = stored.slice(LOCAL_PREFIX.length).split(":");
  if (!ivB64 || !tagB64 || ctB64 === undefined) throw new CiphertextFormatError("expected iv:tag:ciphertext");
  const decipher = createDecipheriv("aes-256-gcm", localKek(), Buffer.from(ivB64, "base64"));
  decipher.setAAD(aad(ctx));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, "base64")), decipher.final()]).toString("utf8");
}
