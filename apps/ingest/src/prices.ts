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
  /** provider -> model -> capability tier (frontier | balanced | fast). */
  private modelTiers = new Map<string, Map<string, string>>();

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
        modelTier: models.tier,
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
    const tiers = new Map<string, Map<string, string>>();
    for (const r of rows) {
      const byModel = tiers.get(r.provider) ?? new Map<string, string>();
      byModel.set(r.model, r.modelTier);
      tiers.set(r.provider, byModel);
      const k = PriceCache.key(r.provider, r.model, r.tier);
      const list = next.get(k) ?? [];
      list.push(r);
      next.set(k, list);
    }
    this.versions = next;
    this.modelTiers = tiers;
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

  modelTier(provider: string, model: string): string | undefined {
    return this.modelTiers.get(provider)?.get(model);
  }

  /**
   * The cheapest model in a tier with a standard price in force at `at`,
   * ranked by input + output rate. Used to price the model-fit suggestion.
   */
  cheapestInTier(provider: string, tier: string, at: Date): { model: string; price: PriceVersion } | null {
    let best: { model: string; price: PriceVersion; rank: number } | null = null;
    for (const [model, t] of this.modelTiers.get(provider) ?? []) {
      if (t !== tier) continue;
      const price = selectPriceVersion(this.versions.get(PriceCache.key(provider, model, "standard")) ?? [], at);
      if (!price) continue;
      const rank = Number(price.inputPerMtok) + Number(price.outputPerMtok);
      if (!best || rank < best.rank) best = { model, price, rank };
    }
    return best ? { model: best.model, price: best.price } : null;
  }
}
