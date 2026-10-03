import { createHmac, timingSafeEqual } from "node:crypto";

export interface Session {
  userId: string;
  orgId: string;
}

export class MissingSessionSecretError extends Error {
  override readonly name = "MissingSessionSecretError";
  constructor() {
    super("TOKENGRID_SESSION_SECRET must be set to at least 32 random characters. See .env.example.");
  }
}

export class DevLoginDisabledError extends Error {
  override readonly name = "DevLoginDisabledError";
  constructor() {
    super("Email-only login is a development stub and is disabled when NODE_ENV=production. Wire a real identity provider into getSession.");
  }
}

export const SESSION_COOKIE = "tg_session";
/** Short-lived on purpose: this cookie gates access to other people's usage. */
export const SESSION_TTL_S = 12 * 3600;

export function sessionSecret(): string {
  const s = process.env.TOKENGRID_SESSION_SECRET;
  if (!s || s.length < 32) throw new MissingSessionSecretError();
  return s;
}

function mac(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function signSession(s: Session, secret: string, now = Date.now()): string {
  const payload = Buffer.from(JSON.stringify({ u: s.userId, o: s.orgId, exp: Math.floor(now / 1000) + SESSION_TTL_S })).toString("base64url");
  return `${payload}.${mac(payload, secret)}`;
}

/** Null for anything not signed by us or past expiry; never throws on hostile input. */
export function verifySession(token: string | undefined, secret: string, now = Date.now()): Session | null {
  if (!token) return null;
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const given = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(mac(payload, secret));
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let body: unknown;
  try {
    body = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof body !== "object" || body === null) return null;
  const { u, o, exp } = body as Record<string, unknown>;
  if (typeof u !== "string" || typeof o !== "string" || typeof exp !== "number") return null;
  if (exp * 1000 <= now) return null;
  return { userId: u, orgId: o };
}
