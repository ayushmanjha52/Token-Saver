import { and, eq, sql } from "drizzle-orm";
import { InvariantViolationError } from "@tokengrid/shared";
import { CATALOG } from "./catalog.js";
import type { Database } from "./client.js";
import { modelPrices, models } from "./schema.js";

/**
 * Loads the price catalog that ships with the code. Runs on every migrate,
 * so a cold deploy prices its first call and a release that adds models
 * makes them priceable without a manual step.
 *
 * Insert-only: an existing (model, tier, effective_from) version is never
 * changed, so a corrected price has to be a new version with a new date,
 * and events already stamped with the old price row keep it.
 */
export async function syncCatalog(db: Database): Promise<number> {
  return db.transaction(async (tx) => {
    // Catalog dates are when the prices were checked, which is in the past;
    // the price guard trigger requires an explicit opt-in for that.
    await tx.execute(sql`select set_config('tokengrid.allow_backdated_price', 'on', true)`);
    let added = 0;
    for (const p of CATALOG) {
      await tx
        .insert(models)
        .values({ provider: p.provider, providerModelId: p.providerModelId, tier: p.tier })
        .onConflictDoUpdate({ target: [models.provider, models.providerModelId], set: { tier: p.tier } });
      const [model] = await tx
        .select({ id: models.id })
        .from(models)
        .where(and(eq(models.provider, p.provider), eq(models.providerModelId, p.providerModelId)));
      if (!model) throw new InvariantViolationError(`model ${p.providerModelId} missing after upsert`);
      const inserted = await tx
        .insert(modelPrices)
        .values({
          modelId: model.id,
          tier: p.pricingTier,
          effectiveFrom: new Date(p.effectiveFrom),
          inputPerMtok: p.inputPerMtok,
          outputPerMtok: p.outputPerMtok,
          cacheReadPerMtok: p.cacheReadPerMtok,
          cacheWrite5mPerMtok: p.cacheWrite5mPerMtok,
          cacheWrite1hPerMtok: p.cacheWrite1hPerMtok,
          source: p.source,
        })
        .onConflictDoNothing()
        .returning({ id: modelPrices.id });
      added += inserted.length;
    }
    return added;
  });
}
