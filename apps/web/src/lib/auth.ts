import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from "node:crypto";
import { and, eq, isNotNull, ne, sql } from "drizzle-orm";
import { schema, type Database } from "@tokengrid/db";
import type { Session } from "./session-token";

export type AuthErrorCode = "invalid_input" | "email_taken" | "bad_credentials" | "locked" | "throttled" | "wrong_password";

export class AuthError extends Error {
  override readonly name = "AuthError";
  constructor(
    readonly code: AuthErrorCode,
    message: string,
  ) {
    super(message);
  }
}

function scrypt(password: string, salt: Buffer, keylen: number, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => scryptCb(password, salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key))));
}

/** scrypt at N=2^15: about 100 ms per guess here, which makes offline cracking of a leaked table slow. */
const SCRYPT = { N: 32768, r: 8, p: 1, keylen: 64, maxmem: 64 * 1024 * 1024 };
export const PASSWORD_MIN = 10;
const PASSWORD_MAX = 200;
const MAX_FAILED_LOGINS = 10;
const LOCK_MS = 15 * 60_000;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, SCRYPT.keylen, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, saltB64, keyB64] = stored.split("$");
  if (scheme !== "scrypt" || !n || !r || !p || !saltB64 || !keyB64) return false;
  const expected = Buffer.from(keyB64, "base64");
  const actual = await scrypt(password, Buffer.from(saltB64, "base64"), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: SCRYPT.maxmem,
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/**
 * Checked against when the email is unknown, so "no such account" costs the
 * same time as "wrong password" and response timing does not reveal who has
 * an account.
 */
let dummyHash: Promise<string> | null = null;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function clean(v: unknown, max: number): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

export interface SignUpInput {
  name: unknown;
  email: unknown;
  organization: unknown;
  password: unknown;
}

export function validateSignUp(input: SignUpInput) {
  const name = clean(input.name, 80);
  const email = clean(input.email, 200).toLowerCase();
  const organization = clean(input.organization, 80);
  const password = typeof input.password === "string" ? input.password : "";
  if (!name) throw new AuthError("invalid_input", "Enter your name.");
  if (!EMAIL.test(email)) throw new AuthError("invalid_input", "Enter a valid email address.");
  if (!organization) throw new AuthError("invalid_input", "Enter an organization name.");
  validatePassword(password);
  return { name, email, organization, password };
}

function validatePassword(password: string): void {
  if (password.length < PASSWORD_MIN) throw new AuthError("invalid_input", `Use at least ${PASSWORD_MIN} characters for the password.`);
  if (password.length > PASSWORD_MAX) throw new AuthError("invalid_input", "That password is too long.");
}

/** Addresses are hashed before storage: the throttle needs to recognise a client, not know who it is. */
function throttleKey(scope: string, ip: string): string {
  return `${scope}:${createHash("sha256").update(ip).digest("hex").slice(0, 32)}`;
}

/** Fixed-window counter in one statement, so concurrent attempts cannot both slip under the limit. */
async function throttle(db: Database, scope: string, ip: string, limit: number, windowMs: number): Promise<void> {
  const t = schema.authThrottle;
  const windowStartedBefore = new Date(Date.now() - windowMs).toISOString();
  const [row] = await db
    .insert(t)
    .values({ key: throttleKey(scope, ip), windowStart: new Date(), attempts: 1 })
    .onConflictDoUpdate({
      target: t.key,
      set: {
        attempts: sql`case when ${t.windowStart} < ${windowStartedBefore}::timestamptz then 1 else ${t.attempts} + 1 end`,
        windowStart: sql`case when ${t.windowStart} < ${windowStartedBefore}::timestamptz then now() else ${t.windowStart} end`,
      },
    })
    .returning({ attempts: t.attempts });
  if ((row?.attempts ?? 0) > limit) throw new AuthError("throttled", "Too many attempts from this network. Try again later.");
}

function isUniqueViolation(err: unknown): boolean {
  for (let e: unknown = err, i = 0; typeof e === "object" && e !== null && i < 5; i++) {
    if ((e as { code?: unknown }).code === "23505") return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Creates a new organization with the person as its admin. An email that
 * already belongs to anyone (including a link-only member of another org)
 * cannot sign up again: two accounts behind one address would make sign-in
 * ambiguous.
 */
export async function signUp(db: Database, input: SignUpInput, ip: string): Promise<Session> {
  const v = validateSignUp(input);
  await throttle(db, "signup", ip, 5, 60 * 60_000);
  const existing = await db.select({ id: schema.users.id }).from(schema.users).where(sql`lower(${schema.users.email}) = ${v.email}`).limit(1);
  if (existing.length > 0) {
    throw new AuthError("email_taken", "That email already has an account. Sign in instead, or ask your admin for a sign-in link.");
  }
  const passwordHash = await hashPassword(v.password);
  try {
    return await db.transaction(async (tx) => {
      const [org] = await tx.insert(schema.organizations).values({ name: v.organization }).returning({ id: schema.organizations.id });
      if (!org) throw new AuthError("invalid_input", "The organization could not be created.");
      const [user] = await tx
        .insert(schema.users)
        .values({ orgId: org.id, email: v.email, displayName: v.name, orgRole: "admin", passwordHash })
        .returning({ id: schema.users.id });
      if (!user) throw new AuthError("invalid_input", "The account could not be created.");
      await tx.insert(schema.auditLog).values({ orgId: org.id, actorUserId: user.id, subjectUserId: user.id, action: "account.created", detail: {} });
      return { userId: user.id, orgId: org.id };
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new AuthError("email_taken", "That email already has an account. Sign in instead.");
    throw err;
  }
}

export async function signIn(db: Database, emailInput: unknown, passwordInput: unknown, ip: string): Promise<Session> {
  const email = clean(emailInput, 200).toLowerCase();
  const password = typeof passwordInput === "string" ? passwordInput : "";
  await throttle(db, "signin", ip, 20, 15 * 60_000);
  const u = schema.users;
  const [user] = await db
    .select({ id: u.id, orgId: u.orgId, passwordHash: u.passwordHash, failedLogins: u.failedLogins, lockedUntil: u.lockedUntil })
    .from(u)
    .where(and(sql`lower(${u.email}) = ${email}`, isNotNull(u.passwordHash)))
    .limit(1);
  const fail = new AuthError("bad_credentials", "Email or password is incorrect.");
  if (!user || !user.passwordHash) {
    dummyHash ??= hashPassword(randomBytes(12).toString("hex"));
    await verifyPassword(password, await dummyHash);
    throw fail;
  }
  if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
    throw new AuthError("locked", "Too many failed attempts. This account is locked for 15 minutes.");
  }
  if (!(await verifyPassword(password, user.passwordHash))) {
    const failures = user.failedLogins + 1;
    const lock = failures >= MAX_FAILED_LOGINS;
    await db
      .update(u)
      .set({ failedLogins: lock ? 0 : failures, lockedUntil: lock ? new Date(Date.now() + LOCK_MS) : null })
      .where(eq(u.id, user.id));
    throw fail;
  }
  await db.update(u).set({ failedLogins: 0, lockedUntil: null }).where(eq(u.id, user.id));
  return { userId: user.id, orgId: user.orgId };
}

/** Sets a first password (link-only accounts) or changes one, which requires the current password. */
export async function setPassword(db: Database, session: Session, current: unknown, next: unknown): Promise<void> {
  const u = schema.users;
  const [user] = await db
    .select({ id: u.id, orgId: u.orgId, email: u.email, passwordHash: u.passwordHash })
    .from(u)
    .where(and(eq(u.id, session.userId), eq(u.orgId, session.orgId)));
  if (!user) throw new AuthError("bad_credentials", "Session user no longer exists.");
  if (user.passwordHash && !(typeof current === "string" && (await verifyPassword(current, user.passwordHash)))) {
    throw new AuthError("wrong_password", "The current password is incorrect.");
  }
  const password = typeof next === "string" ? next : "";
  validatePassword(password);
  const taken = await db
    .select({ id: u.id })
    .from(u)
    .where(and(sql`lower(${u.email}) = lower(${user.email})`, isNotNull(u.passwordHash), ne(u.id, user.id)))
    .limit(1);
  if (taken.length > 0) throw new AuthError("email_taken", "Another account already signs in with this email and a password.");
  try {
    await db.update(u).set({ passwordHash: await hashPassword(password), failedLogins: 0, lockedUntil: null }).where(eq(u.id, user.id));
  } catch (err) {
    if (isUniqueViolation(err)) throw new AuthError("email_taken", "Another account already signs in with this email and a password.");
    throw err;
  }
  await db.insert(schema.auditLog).values({ orgId: user.orgId, actorUserId: user.id, subjectUserId: user.id, action: "password.set", detail: {} });
}

/**
 * Rejects cross-site form posts. Browsers send Origin on POST; a mismatch
 * means another site is submitting into ours (login CSRF), so it is refused
 * rather than signing the visitor into someone else's account.
 */
export function sameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).host === new URL(req.url).host;
  } catch {
    return false;
  }
}

export function clientIp(req: Request): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "unknown";
}
