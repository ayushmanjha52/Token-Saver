import { createHash, randomBytes } from "node:crypto";

const KEY_PREFIX = "tgk_";

export interface IssuedVirtualKey {
  /** Shown to the user exactly once; never stored. */
  plaintext: string;
  keyPrefix: string;
  keyHash: string;
}

export function hashVirtualKey(plaintext: string): string {
  return createHash("sha256").update(plaintext, "utf8").digest("hex");
}

export function isVirtualKeyShape(candidate: string): boolean {
  return candidate.startsWith(KEY_PREFIX) && candidate.length === KEY_PREFIX.length + 43;
}

export function issueVirtualKey(): IssuedVirtualKey {
  const plaintext = KEY_PREFIX + randomBytes(32).toString("base64url");
  return { plaintext, keyPrefix: plaintext.slice(0, 12), keyHash: hashVirtualKey(plaintext) };
}
