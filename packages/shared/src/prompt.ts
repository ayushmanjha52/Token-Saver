import { createHash } from "node:crypto";

/**
 * What the gateway keeps about a prompt: hashes and sizes, never text.
 *
 * Prompt storage is off by default (CLAUDE.md, constraint 4), so retry
 * detection and lint have to work from these. A fingerprint of a short
 * prompt can still be confirmed by someone who guesses the prompt, which is
 * why these rows are pruned on the same schedule as other usage detail.
 */
export interface PromptFeatures {
  /** sha256 of the normalised head of the whole prompt; groups templated requests. */
  fingerprint: string;
  /** 64-bit simhash of the normalised final user turn, as 16 hex chars. */
  lastUserSimhash: string;
  lastUserChars: number;
  /**
   * Hash of the digit runs in the final user turn, in order. Normalisation
   * masks digits so templated prompts group together; this restores the
   * distinction for retries, where "feeder 7" and "feeder 14" are different
   * questions, not a resend.
   */
  lastUserNumbers: string;
  messageCount: number;
  /** sha256 of everything before the final user turn, byte-exact, as a cache prefix would see it. Null when empty. */
  prefixHash: string | null;
  prefixChars: number;
  totalChars: number;
  hasSystem: boolean;
  /** An explicit output shape: structured-output config, tools, or a format instruction in the text. */
  hasFormatSpec: boolean;
  usesCacheControl: boolean;
  /** Retries are only matched within one session. */
  sessionKey: string;
}

export const FINGERPRINT_HEAD = 4000;

/** Lowercase, digits to #, punctuation stripped, whitespace collapsed, as specified for retry fingerprints. */
export function normalizePrompt(text: string): string {
  return text
    .toLowerCase()
    // Punctuation first, so a literal "#" in the text cannot pass for a masked digit.
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\p{Nd}/gu, "#")
    .replace(/\s+/g, " ")
    .trim();
}

export function fingerprint(text: string): string {
  return createHash("sha256").update(normalizePrompt(text).slice(0, FINGERPRINT_HEAD)).digest("hex").slice(0, 32);
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 32);
}

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK64 = (1n << 64n) - 1n;

function fnv1a64(s: string): bigint {
  let h = FNV_OFFSET;
  for (let i = 0; i < s.length; i++) {
    h ^= BigInt(s.charCodeAt(i));
    h = (h * FNV_PRIME) & MASK64;
  }
  return h;
}

/** Long turns are sampled from their head; past this, near-duplicate judgement does not improve. */
const SIMHASH_MAX_CHARS = 20_000;

/**
 * Charikar simhash over word 3-shingles of the normalised text. Two turns
 * that differ by a few words land a few bits apart, which is what lets a
 * lightly reworded resend still count as a retry.
 */
export function simhash64(text: string): string {
  const words = normalizePrompt(text).slice(0, SIMHASH_MAX_CHARS).split(" ").filter(Boolean);
  const shingles = words.length < 3 ? [words.join(" ")] : words.slice(0, -2).map((_, i) => `${words[i]} ${words[i + 1]} ${words[i + 2]}`);
  const v = new Array<number>(64).fill(0);
  for (const sh of shingles) {
    const h = fnv1a64(sh);
    for (let b = 0; b < 64; b++) v[b] = (v[b] ?? 0) + ((h >> BigInt(b)) & 1n ? 1 : -1);
  }
  let out = 0n;
  for (let b = 0; b < 64; b++) if ((v[b] ?? 0) > 0) out |= 1n << BigInt(b);
  return out.toString(16).padStart(16, "0");
}

export function numbersDigest(text: string): string {
  return sha256Hex((text.match(/\p{Nd}+/gu) ?? []).join(","));
}

export function hammingHex64(a: string, b: string): number {
  let x = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  let n = 0;
  while (x) {
    n += Number(x & 1n);
    x >>= 1n;
  }
  return n;
}

const FORMAT_HINT = /\b(json|yaml|xml|csv|markdown|table|bullet(ed)? (list|points)|numbered list|schema|respond (only )?(with|in)|return only|output (as|in|only)|format)\b/i;

export function mentionsFormat(text: string): boolean {
  return FORMAT_HINT.test(text);
}

/** Retry matching thresholds. */
export const RETRY_WINDOW_MS = 15 * 60_000;
export const RETRY_MAX_HAMMING = 3;
export const RETRY_LENGTH_TOLERANCE = 0.2;

/**
 * Structural check that must pass before two same-fingerprint requests count
 * as a retry. The fingerprint is the head of the whole prompt, so two
 * different questions under one long system prompt share it; the final user
 * turn and conversation shape must also match.
 */
export function isStructuralRetry(
  a: Pick<PromptFeatures, "fingerprint" | "lastUserSimhash" | "lastUserChars" | "lastUserNumbers" | "messageCount">,
  b: Pick<PromptFeatures, "fingerprint" | "lastUserSimhash" | "lastUserChars" | "lastUserNumbers" | "messageCount">,
): boolean {
  if (a.fingerprint !== b.fingerprint || a.messageCount !== b.messageCount) return false;
  if (a.lastUserNumbers !== b.lastUserNumbers) return false;
  const longer = Math.max(a.lastUserChars, b.lastUserChars, 1);
  if (Math.abs(a.lastUserChars - b.lastUserChars) / longer > RETRY_LENGTH_TOLERANCE) return false;
  return hammingHex64(a.lastUserSimhash, b.lastUserSimhash) <= RETRY_MAX_HAMMING;
}
