import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { DecryptCommand, GenerateDataKeyCommand, KMSClient } from "@aws-sdk/client-kms";

export class LocalKeyInProductionError extends Error {
  override readonly name = "LocalKeyInProductionError";
  constructor() {
    super(
      "Local envelope encryption is disabled when NODE_ENV=production. Set TOKENGRID_KMS_KEY_ID to an AWS KMS key " +
        "and re-store credentials (pnpm --filter @tokengrid/ingest credential ...) so they are KMS-encrypted.",
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

export class KmsUnavailableError extends Error {
  override readonly name = "KmsUnavailableError";
  constructor(op: "encrypt" | "decrypt", cause: unknown) {
    super(`KMS ${op} failed; the credential cannot be ${op === "encrypt" ? "stored" : "used"} until KMS is reachable.`, { cause });
  }
}

/** Identifies what a ciphertext protects; mixed into GCM's AAD and KMS's encryption context. */
export interface SecretContext {
  orgId: string;
  provider: string;
}

/** The two KMS operations envelope encryption needs; an interface so tests can supply a fake. */
export interface KmsClientLike {
  generateDataKey(keyId: string, context: Record<string, string>): Promise<{ plaintext: Uint8Array; encrypted: Uint8Array }>;
  decrypt(keyId: string, encrypted: Uint8Array, context: Record<string, string>): Promise<Uint8Array>;
}

const LOCAL_PREFIX = "local:v1:";
const KMS_PREFIX = "kms:v1:";

let kmsOverride: KmsClientLike | null = null;
let kmsDefault: KmsClientLike | null = null;

/** Test seam: replaces the AWS client. Pass null to restore it. */
export function setKmsClient(client: KmsClientLike | null): void {
  kmsOverride = client;
}

function awsKms(): KmsClientLike {
  // Region and credentials come from the standard AWS environment (role, env vars, profile).
  const client = new KMSClient({});
  return {
    async generateDataKey(keyId, context) {
      const out = await client.send(new GenerateDataKeyCommand({ KeyId: keyId, KeySpec: "AES_256", EncryptionContext: context }));
      if (!out.Plaintext || !out.CiphertextBlob) throw new CiphertextFormatError("KMS returned no data key");
      return { plaintext: out.Plaintext, encrypted: out.CiphertextBlob };
    },
    async decrypt(keyId, encrypted, context) {
      const out = await client.send(new DecryptCommand({ KeyId: keyId, CiphertextBlob: encrypted, EncryptionContext: context }));
      if (!out.Plaintext) throw new CiphertextFormatError("KMS returned no plaintext");
      return out.Plaintext;
    },
  };
}

function kms(): KmsClientLike {
  if (kmsOverride) return kmsOverride;
  kmsDefault ??= awsKms();
  return kmsDefault;
}

function kmsKeyId(): string | undefined {
  return process.env.TOKENGRID_KMS_KEY_ID || undefined;
}

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

/** The same binding on the KMS side: KMS refuses to release the data key for any other org or provider. */
function kmsContext(ctx: SecretContext): Record<string, string> {
  return { purpose: "tokengrid-provider-credential", org: ctx.orgId, provider: ctx.provider };
}

function seal(key: Buffer, plaintext: string, ctx: SecretContext): [string, string, string] {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad(ctx));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [iv.toString("base64"), cipher.getAuthTag().toString("base64"), ct.toString("base64")];
}

function open(key: Buffer, ivB64: string, tagB64: string, ctB64: string, ctx: SecretContext): string {
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
  decipher.setAAD(aad(ctx));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, "base64")), decipher.final()]).toString("utf8");
}

/**
 * Envelope encryption. With TOKENGRID_KMS_KEY_ID set, each secret gets its
 * own AWS KMS data key: the secret is sealed with AES-256-GCM under that key
 * and only the KMS-encrypted data key is stored beside it, so a database dump
 * is useless without KMS access. Without it, a local key is used, which
 * refuses to run in production.
 */
export async function encryptSecret(plaintext: string, ctx: SecretContext): Promise<string> {
  const keyId = kmsKeyId();
  if (!keyId) return `${LOCAL_PREFIX}${seal(localKek(), plaintext, ctx).join(":")}`;
  let dataKey: { plaintext: Uint8Array; encrypted: Uint8Array };
  try {
    dataKey = await kms().generateDataKey(keyId, kmsContext(ctx));
  } catch (err) {
    throw new KmsUnavailableError("encrypt", err);
  }
  const key = Buffer.from(dataKey.plaintext);
  try {
    return `${KMS_PREFIX}${Buffer.from(dataKey.encrypted).toString("base64")}:${seal(key, plaintext, ctx).join(":")}`;
  } finally {
    // The plaintext data key is never needed again; do not leave it in the heap.
    key.fill(0);
    dataKey.plaintext.fill(0);
  }
}

export async function decryptSecret(stored: string, ctx: SecretContext): Promise<string> {
  if (stored.startsWith(LOCAL_PREFIX)) {
    const [iv, tag, ct] = stored.slice(LOCAL_PREFIX.length).split(":");
    if (!iv || !tag || ct === undefined) throw new CiphertextFormatError("expected iv:tag:ciphertext");
    return open(localKek(), iv, tag, ct, ctx);
  }
  if (!stored.startsWith(KMS_PREFIX)) throw new CiphertextFormatError("unknown scheme prefix");
  const keyId = kmsKeyId();
  if (!keyId) throw new CiphertextFormatError("KMS-encrypted credential but TOKENGRID_KMS_KEY_ID is not set");
  const [blob, iv, tag, ct] = stored.slice(KMS_PREFIX.length).split(":");
  if (!blob || !iv || !tag || ct === undefined) throw new CiphertextFormatError("expected dataKey:iv:tag:ciphertext");
  let plainKey: Uint8Array;
  try {
    plainKey = await kms().decrypt(keyId, Buffer.from(blob, "base64"), kmsContext(ctx));
  } catch (err) {
    throw new KmsUnavailableError("decrypt", err);
  }
  const key = Buffer.from(plainKey);
  try {
    return open(key, iv, tag, ct, ctx);
  } finally {
    key.fill(0);
    plainKey.fill(0);
  }
}
