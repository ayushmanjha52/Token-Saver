import { schema, type Database } from "@tokengrid/db";
import { computeCost, UnpricedUsageError, type UsageEventV1 } from "@tokengrid/shared";
import type { PriceCache } from "./prices.js";

export type IngestOutcome = "inserted" | "duplicate";

/**
 * Prices and stores one event, exactly once.
 *
 * The ledger insert and the event insert share a transaction: if the worker
 * dies between them, both roll back and the redelivered entry inserts
 * cleanly. Claiming the ledger row in a separate step would let a crash leave
 * a claimed id with no event, and every redelivery would then be skipped as a
 * duplicate — a silent under-count.
 */
export async function ingestEvent(db: Database, prices: PriceCache, event: UsageEventV1): Promise<IngestOutcome> {
  if (Object.keys(event.unpricedUnits).length > 0) throw new UnpricedUsageError(event.unpricedUnits);

  const occurredAt = new Date(event.occurredAt);
  const price = await prices.resolve(event.provider, event.model, event.pricingTier, occurredAt);
  const cost = computeCost(event.usage, price);

  return db.transaction(async (tx) => {
    const claimed = await tx
      .insert(schema.usageEventIds)
      .values({ provider: event.provider, providerRequestId: event.providerRequestId, occurredAt })
      .onConflictDoNothing()
      .returning({ id: schema.usageEventIds.providerRequestId });
    if (claimed.length === 0) return "duplicate";

    await tx
      .insert(schema.usageEvents)
      .values({
        occurredAt,
        provider: event.provider,
        providerRequestId: event.providerRequestId,
        orgId: event.orgId,
        userId: event.userId,
        virtualKeyId: event.virtualKeyId,
        model: event.model,
        pricingTier: event.pricingTier,
        priceId: price.id,
        inputTokens: event.usage.inputTokens,
        outputTokens: event.usage.outputTokens,
        cacheReadTokens: event.usage.cacheReadTokens,
        cacheWrite5mTokens: event.usage.cacheWrite5mTokens,
        cacheWrite1hTokens: event.usage.cacheWrite1hTokens,
        costUsd: cost.costUsd,
        durationMs: event.durationMs,
        httpStatus: event.httpStatus,
        streamed: event.streamed,
        usageComplete: event.usageComplete,
        stopReason: event.stopReason,
      })
      .onConflictDoNothing();
    return "inserted";
  });
}
