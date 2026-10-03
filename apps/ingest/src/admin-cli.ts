/**
 * Operator CLI for a fresh deployment, before (or instead of) any admin UI:
 *
 *   admin org create   --name "Acme" --admin-email ops@acme.com --admin-name "Ops" [--retention-days 395]
 *   admin user add     --org "Acme" --email dev@acme.com --name "Dev" [--admin]
 *   admin team member  --org "Acme" --team Platform --email dev@acme.com --role member|manager
 *   admin key issue    --email dev@acme.com [--name laptop]          (prints the key once)
 *   admin key revoke   --prefix tgk_AbCdEfGh
 *   admin login-link   --email dev@acme.com --base-url https://tokengrid.acme.com
 *
 * In production run the bundled build: node apps/ingest/dist/admin-cli.js ...
 */
import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import { and, eq, isNull } from "drizzle-orm";
import { Redis } from "ioredis";
import { createDb, issueVirtualKey, schema, type Database } from "@tokengrid/db";
import { LOGIN_LINK_TTL_MINUTES, signLoginLink, virtualKeyCacheKey } from "@tokengrid/shared";

export class AdminCliError extends Error {
  override readonly name = "AdminCliError";
}

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    name: { type: "string" },
    org: { type: "string" },
    email: { type: "string" },
    team: { type: "string" },
    role: { type: "string" },
    prefix: { type: "string" },
    admin: { type: "boolean" },
    "admin-email": { type: "string" },
    "admin-name": { type: "string" },
    "retention-days": { type: "string" },
    "base-url": { type: "string" },
  },
});
const command = positionals.join(" ");

function need(v: string | undefined, flag: string): string {
  if (!v) throw new AdminCliError(`--${flag} is required for "${command}"`);
  return v;
}

async function orgByName(db: Database, name: string): Promise<string> {
  const rows = await db.select({ id: schema.organizations.id }).from(schema.organizations).where(eq(schema.organizations.name, name));
  if (rows.length !== 1 || !rows[0]) throw new AdminCliError(`expected exactly one org named "${name}", found ${rows.length}`);
  return rows[0].id;
}

async function userByEmail(db: Database, email: string) {
  const rows = await db.select({ id: schema.users.id, orgId: schema.users.orgId }).from(schema.users).where(eq(schema.users.email, email.toLowerCase()));
  if (rows.length !== 1 || !rows[0]) throw new AdminCliError(`expected exactly one user with email ${email}, found ${rows.length}`);
  return rows[0];
}

const { db, sql } = createDb(undefined, { max: 1 });
try {
  switch (command) {
    case "org create": {
      const days = Number(values["retention-days"] ?? "395");
      const [org] = await db.insert(schema.organizations).values({ name: need(values.name, "name"), retentionDays: days }).returning();
      if (!org) throw new AdminCliError("org insert returned nothing");
      const [admin] = await db
        .insert(schema.users)
        .values({ orgId: org.id, email: need(values["admin-email"], "admin-email").toLowerCase(), displayName: need(values["admin-name"], "admin-name"), orgRole: "admin" })
        .returning();
      console.log(`org ${org.id} "${org.name}" (retention ${days} days); admin ${admin?.email}`);
      break;
    }
    case "user add": {
      const orgId = await orgByName(db, need(values.org, "org"));
      const [u] = await db
        .insert(schema.users)
        .values({ orgId, email: need(values.email, "email").toLowerCase(), displayName: need(values.name, "name"), orgRole: values.admin ? "admin" : "member" })
        .returning();
      console.log(`user ${u?.id} ${u?.email}${values.admin ? " (org admin)" : ""}`);
      break;
    }
    case "team member": {
      const orgId = await orgByName(db, need(values.org, "org"));
      const role = values.role ?? "member";
      if (role !== "member" && role !== "manager") throw new AdminCliError("--role must be member or manager");
      const teamName = need(values.team, "team");
      await db.insert(schema.teams).values({ orgId, name: teamName }).onConflictDoNothing();
      const [team] = await db.select().from(schema.teams).where(and(eq(schema.teams.orgId, orgId), eq(schema.teams.name, teamName)));
      const u = await userByEmail(db, need(values.email, "email"));
      if (!team || u.orgId !== orgId) throw new AdminCliError("user and team must be in the same org");
      await db
        .insert(schema.memberships)
        .values({ teamId: team.id, userId: u.id, role })
        .onConflictDoUpdate({ target: [schema.memberships.teamId, schema.memberships.userId], set: { role } });
      console.log(`${values.email} is a ${role} of ${teamName}`);
      break;
    }
    case "key issue": {
      const u = await userByEmail(db, need(values.email, "email"));
      const key = issueVirtualKey();
      await db.insert(schema.virtualKeys).values({ orgId: u.orgId, userId: u.id, name: values.name ?? "cli", keyPrefix: key.keyPrefix, keyHash: key.keyHash });
      console.log(`Virtual key for ${values.email} (shown once, not stored):\n  ${key.plaintext}`);
      break;
    }
    case "key revoke": {
      const prefix = need(values.prefix, "prefix").slice(0, 12);
      const revoked = await db
        .update(schema.virtualKeys)
        .set({ revokedAt: new Date() })
        .where(and(eq(schema.virtualKeys.keyPrefix, prefix), isNull(schema.virtualKeys.revokedAt)))
        .returning({ hash: schema.virtualKeys.keyHash });
      // The gateway caches resolved keys in Redis for minutes; dropping the
      // entry makes revocation bite within the gateway's 60s memory cache.
      if (process.env.REDIS_URL && revoked.length > 0) {
        const redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 1 });
        try {
          await redis.del(...revoked.map((r) => virtualKeyCacheKey(r.hash)));
        } finally {
          redis.disconnect();
        }
      }
      console.log(`revoked ${revoked.length} key(s) with prefix ${prefix}${process.env.REDIS_URL ? "" : " (REDIS_URL unset: cached entries expire within 5 minutes)"}`);
      break;
    }
    case "login-link": {
      const secret = process.env.TOKENGRID_SESSION_SECRET;
      if (!secret || secret.length < 32) throw new AdminCliError("TOKENGRID_SESSION_SECRET (the dashboard's) is required to sign links");
      const u = await userByEmail(db, need(values.email, "email"));
      const nonce = randomBytes(18).toString("base64url");
      const expiresAt = new Date(Date.now() + LOGIN_LINK_TTL_MINUTES * 60_000);
      await db.insert(schema.loginLinks).values({ nonce, userId: u.id, expiresAt });
      const token = signLoginLink({ nonce, userId: u.id, orgId: u.orgId, exp: Math.floor(expiresAt.getTime() / 1000) }, secret);
      const base = need(values["base-url"], "base-url").replace(/\/+$/, "");
      console.log(`${base}/api/session/link?token=${token}`);
      console.error(`single use, expires ${expiresAt.toISOString()}`);
      break;
    }
    default:
      throw new AdminCliError("commands: org create | user add | team member | key issue | key revoke | login-link (see the header of admin-cli.ts)");
  }
} finally {
  await sql.end();
}
