import { eq } from "drizzle-orm";
import { schema, type Database } from "@tokengrid/db";
import { PriceNotFoundError, selectPriceVersion, type PriceVersion } from "@tokengrid/shared";

const REFRESH_MS = 60_000;
/** A missing price forces a reload at most this often, so a burst of unpriceable events cannot hammer Postgres. */
const MISS_RELOAD_MS = 10_000;

/**
 * Every price version in memory, keyed by provider/model/tier.
 *
 * The cache holds all versions, not just current ones, so the lookup by
 * event timestamp is correct even for an event that arrives after a price
 * change has landed: it still resolves to the version that was in force when
 * the call was made.
 */
export class PriceCache {
  private versions = new Map<string, PriceVersion[]>();
  private loadedAt = 0;
  private lastMissReload = 0;

  constructor(private readonly db: Database) {}

  private static key(provider: string, model: string, tier: string): string {
    return `${provider}\u0000${model}\u0000${tier}`;
  }

  async load(): Promise<void> {
    const { models, modelPrices } = schema;
    const rows = await this.db
      .select({
        id: modelPrices.id,
        provider: models.provider,
        model: models.providerModelId,
        tier: modelPrices.tier,
        effectiveFrom: modelPrices.effectiveFrom,
        effectiveTo: modelPrices.effectiveTo,
        inputPerMtok: modelPrices.inputPerMtok,
        outputPerMtok: modelPrices.outputPerMtok,
        cacheReadPerMtok: modelPrices.cacheReadPerMtok,
        cacheWrite5mPerMtok: modelPrices.cacheWrite5mPerMtok,
        cacheWrite1hPerMtok: modelPrices.cacheWrite1hPerMtok,
      })
      .from(modelPrices)
      .innerJoin(models, eq(models.id, modelPrices.modelId));
    const next = new Map<string, PriceVersion[]>();
    for (const r of rows) {
      const k = PriceCache.key(r.provider, r.model, r.tier);
      const list = next.get(k) ?? [];
      list.push(r);
      next.set(k, list);
    }
    this.versions = next;
    this.loadedAt = Date.now();
  }

  async resolve(provider: string, model: string, tier: string, at: Date): Promise<PriceVersion> {
    const now = Date.now();
    if (now - this.loadedAt > REFRESH_MS) await this.load();
    const k = PriceCache.key(provider, model, tier);
    let found = selectPriceVersion(this.versions.get(k) ?? [], at);
    if (!found && now - this.lastMissReload > MISS_RELOAD_MS) {
      this.lastMissReload = now;
      await this.load();
      found = selectPriceVersion(this.versions.get(k) ?? [], at);
    }
    if (!found) throw new PriceNotFoundError(provider, model, tier, at);
    return found;
  }
}
