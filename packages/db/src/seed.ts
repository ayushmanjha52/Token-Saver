import { and, eq, isNull } from "drizzle-orm";
import { InvariantViolationError, type Provider } from "@tokengrid/shared";
import { createDb } from "./client.js";
import { CATALOG } from "./catalog.js";
import { syncCatalog } from "./catalog-sync.js";
import { encryptSecret } from "./crypto.js";
import { issueVirtualKey } from "./keys.js";
import {
  drilldownConsents,
  memberships,
  organizations,
  providerCredentials,
  teams,
  users,
  virtualKeys,
} from "./schema.js";

export class MissingSeedCredentialError extends Error {
  override readonly name = "MissingSeedCredentialError";
  constructor() {
    super(
      "SEED_ANTHROPIC_API_KEY is not set. The demo org needs a real upstream key to forward to; " +
        "use one from a dedicated Anthropic workspace so its console cost is comparable.",
    );
  }
}

const DEMO_ORG = "Demo Org";
const DEMO_TEAM = "Platform";

/**
 * The demo cast covers each access path the dashboard must get right: an
 * admin, a team manager, a member who has allowed drill-down and one who
 * has not.
 */
const PEOPLE = [
  { email: "admin@tokengrid.local", displayName: "Demo Admin", orgRole: "admin", teamRole: null, consents: false },
  { email: "manager@tokengrid.local", displayName: "Demo Manager", orgRole: "member", teamRole: "manager", consents: false },
  { email: "a@tokengrid.local", displayName: "Demo Member A", orgRole: "member", teamRole: "member", consents: true },
  { email: "b@tokengrid.local", displayName: "Demo Member B", orgRole: "member", teamRole: "member", consents: false },
  { email: "c@tokengrid.local", displayName: "Demo Member C", orgRole: "member", teamRole: "member", consents: false },
] as const;

async function findOrCreate<T>(find: () => Promise<T | undefined>, create: () => Promise<T | undefined>, what: string): Promise<T> {
  const row = (await find()) ?? (await create());
  if (!row) throw new InvariantViolationError(`${what} insert returned nothing`);
  return row;
}

const upstreamKey = process.env.SEED_ANTHROPIC_API_KEY;
if (!upstreamKey) throw new MissingSeedCredentialError();

const { db, sql: client } = createDb(undefined, { max: 1 });
try {
  await syncCatalog(db);
  await db.transaction(async (tx) => {

    const org = await findOrCreate(
      async () => (await tx.select().from(organizations).where(eq(organizations.name, DEMO_ORG)))[0],
      async () => (await tx.insert(organizations).values({ name: DEMO_ORG }).returning())[0],
      "org",
    );
    const team = await findOrCreate(
      async () => (await tx.select().from(teams).where(and(eq(teams.orgId, org.id), eq(teams.name, DEMO_TEAM))))[0],
      async () => (await tx.insert(teams).values({ orgId: org.id, name: DEMO_TEAM }).returning())[0],
      "team",
    );

    // OpenAI is optional: without its key, OpenAI routes answer 403 for this org.
    const credentials: [Provider, string | undefined][] = [
      ["anthropic", upstreamKey],
      ["openai", process.env.SEED_OPENAI_API_KEY],
    ];
    for (const [provider, secret] of credentials) {
      if (!secret) continue;
      // Rotate rather than update in place, so the partial unique index keeps
      // exactly one live credential and the old ciphertext stays auditable.
      await tx
        .update(providerCredentials)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(providerCredentials.orgId, org.id),
            eq(providerCredentials.provider, provider),
            eq(providerCredentials.kind, "api"),
            isNull(providerCredentials.revokedAt),
          ),
        );
      await tx.insert(providerCredentials).values({
        orgId: org.id,
        provider,
        ciphertext: await encryptSecret(secret, { orgId: org.id, provider }),
      });
    }

    console.log(`catalog: ${CATALOG.length} model prices`);
    console.log(`org  ${org.id}  ${org.name}`);
    console.log(`team ${team.id}  ${team.name}`);
    console.log("");
    console.log("Virtual keys (shown once, not stored):");
    for (const p of PEOPLE) {
      const user = await findOrCreate(
        async () => (await tx.select().from(users).where(and(eq(users.orgId, org.id), eq(users.email, p.email))))[0],
        async () =>
          (await tx.insert(users).values({ orgId: org.id, email: p.email, displayName: p.displayName, orgRole: p.orgRole }).returning())[0],
        `user ${p.email}`,
      );
      if (p.teamRole) {
        await tx.insert(memberships).values({ teamId: team.id, userId: user.id, role: p.teamRole }).onConflictDoNothing();
      }
      if (p.consents) {
        await tx.insert(drilldownConsents).values({ orgId: org.id, subjectUserId: user.id }).onConflictDoNothing();
      }
      const key = issueVirtualKey();
      await tx.insert(virtualKeys).values({
        orgId: org.id,
        userId: user.id,
        name: "seed",
        keyPrefix: key.keyPrefix,
        keyHash: key.keyHash,
      });
      console.log(`  ${p.email.padEnd(24)} ${key.plaintext}`);
    }
  });
} finally {
  await client.end();
}
