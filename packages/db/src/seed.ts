import { and, eq, isNull } from "drizzle-orm";
import { InvariantViolationError } from "@tokengrid/shared";
import { createDb } from "./client.js";
import { CATALOG } from "./catalog.js";
import { encryptSecret } from "./crypto.js";
import { issueVirtualKey } from "./keys.js";
import { modelPrices, models, organizations, providerCredentials, users, virtualKeys } from "./schema.js";

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
const DEMO_EMAIL = "demo@tokengrid.local";

const upstreamKey = process.env.SEED_ANTHROPIC_API_KEY;
if (!upstreamKey) throw new MissingSeedCredentialError();

const { db, sql } = createDb(undefined, { max: 1 });
try {
  await db.transaction(async (tx) => {
    for (const p of CATALOG) {
      await tx
        .insert(models)
        .values({ provider: p.provider, providerModelId: p.providerModelId })
        .onConflictDoNothing();
      const [model] = await tx
        .select({ id: models.id })
        .from(models)
        .where(and(eq(models.provider, p.provider), eq(models.providerModelId, p.providerModelId)));
      if (!model) throw new InvariantViolationError(`model ${p.providerModelId} missing after upsert`);
      await tx
        .insert(modelPrices)
        .values({
          modelId: model.id,
          tier: p.tier,
          effectiveFrom: new Date(p.effectiveFrom),
          inputPerMtok: p.inputPerMtok,
          outputPerMtok: p.outputPerMtok,
          cacheReadPerMtok: p.cacheReadPerMtok,
          cacheWrite5mPerMtok: p.cacheWrite5mPerMtok,
          cacheWrite1hPerMtok: p.cacheWrite1hPerMtok,
          source: p.source,
        })
        .onConflictDoNothing();
    }

    let [org] = await tx.select().from(organizations).where(eq(organizations.name, DEMO_ORG));
    if (!org) [org] = await tx.insert(organizations).values({ name: DEMO_ORG }).returning();
    if (!org) throw new InvariantViolationError("demo org insert returned nothing");

    let [user] = await tx
      .select()
      .from(users)
      .where(and(eq(users.orgId, org.id), eq(users.email, DEMO_EMAIL)));
    if (!user) {
      [user] = await tx
        .insert(users)
        .values({ orgId: org.id, email: DEMO_EMAIL, displayName: "Demo User" })
        .returning();
    }
    if (!user) throw new InvariantViolationError("demo user insert returned nothing");

    // Rotate rather than update in place, so the partial unique index keeps
    // exactly one live credential and the old ciphertext stays auditable.
    await tx
      .update(providerCredentials)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(providerCredentials.orgId, org.id),
          eq(providerCredentials.provider, "anthropic"),
          isNull(providerCredentials.revokedAt),
        ),
      );
    await tx.insert(providerCredentials).values({
      orgId: org.id,
      provider: "anthropic",
      ciphertext: encryptSecret(upstreamKey, { orgId: org.id, provider: "anthropic" }),
    });

    const key = issueVirtualKey();
    await tx.insert(virtualKeys).values({
      orgId: org.id,
      userId: user.id,
      name: "seed",
      keyPrefix: key.keyPrefix,
      keyHash: key.keyHash,
    });

    console.log(`catalog: ${CATALOG.length} model prices`);
    console.log(`org  ${org.id}  ${org.name}`);
    console.log(`user ${user.id}  ${user.email}`);
    console.log("");
    console.log("Virtual key (shown once, not stored):");
    console.log(`  ${key.plaintext}`);
  });
} finally {
  await sql.end();
}
