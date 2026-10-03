import { createHmac, timingSafeEqual } from "node:crypto";

export interface LoginLinkClaims {
  nonce: string;
  userId: string;
  orgId: string;
  /** Unix seconds. */
  exp: number;
}

/** Links are short-lived: they travel over chat and email, where they can sit unread and be forwarded. */
export const LOGIN_LINK_TTL_MINUTES = 15;

function mac(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(`login-link:${payload}`).digest("base64url");
}

export function signLoginLink(claims: LoginLinkClaims, secret: string): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${payload}.${mac(payload, secret)}`;
}

/**
 * Verifies signature and expiry only. Single use is enforced by the
 * login_links row, which the caller must claim atomically.
 */
export function verifyLoginLink(token: string, secret: string, now = Date.now()): LoginLinkClaims | null {
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const given = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(mac(payload, secret));
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let c: unknown;
  try {
    c = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof c !== "object" || c === null) return null;
  const { nonce, userId, orgId, exp } = c as Record<string, unknown>;
  if (typeof nonce !== "string" || typeof userId !== "string" || typeof orgId !== "string" || typeof exp !== "number") return null;
  if (exp * 1000 <= now) return null;
  return { nonce, userId, orgId, exp };
}
