import { sql, type AnyColumn } from "drizzle-orm";
import { schema, type Database } from "@tokengrid/db";
import { computeCost, UnpricedUsageError, type UsageEventV1 } from "@tokengrid/shared";
import { recordPromptAndDetectRetry } from "./efficiency.js";
import type { PriceCache } from "./prices.js";

export type IngestOutcome = "inserted" | "duplicate";

export interface IngestResult {
  outcome: IngestOutcome;
  /** Cost of this event; zero for a duplicate, which was already counted. */
  costPico: bigint;
}

const HOUR_MS = 3_600_000;

/**
 * Prices and stores one event, exactly once, and folds it into the hourly
 * rollup.
 *
 * The ledger insert, the event insert and the rollup upsert share a
 * transaction. If the worker dies between them, all three roll back and the
 * redelivered entry inserts cleanly. Claiming the ledger row in a separate
 * step would let a crash leave a claimed id with no event, and every
 * redelivery would then be skipped as a duplicate — a silent under-count.
 */
export async function ingestEvent(db: Database, prices: PriceCache, event: UsageEventV1): Promise<IngestResult> {
  if (Object.keys(event.unpricedUnits).length > 0) throw new UnpricedUsageError(event.unpricedUnits);

  const occurredAt = new Date(event.occurredAt);
  const price = await prices.resolve(event.provider, event.model, event.pricingTier, occurredAt);
  const cost = computeCost(event.usage, price);
  const u = event.usage;

  const outcome = await db.transaction(async (tx): Promise<IngestOutcome> => {
    const claimed = await tx
      .insert(schema.usageEventIds)
      .values({ provider: event.provider, providerRequestId: event.providerRequestId, occurredAt })
      .onConflictDoNothing()
      .returning({ id: schema.usageEventIds.providerRequestId });
    if (claimed.length === 0) return "duplicate";

    await tx.insert(schema.usageEvents).values({
      occurredAt,
      provider: event.provider,
      providerRequestId: event.providerRequestId,
      orgId: event.orgId,
      userId: event.userId,
      virtualKeyId: event.virtualKeyId,
      model: event.model,
      pricingTier: event.pricingTier,
      priceId: price.id,
      inputTokens: u.inputTokens,
      outputTokens: u.outputTokens,
      cacheReadTokens: u.cacheReadTokens,
      cacheWrite5mTokens: u.cacheWrite5mTokens,
      cacheWrite1hTokens: u.cacheWrite1hTokens,
      costUsd: cost.costUsd,
      durationMs: event.durationMs,
      httpStatus: event.httpStatus,
      streamed: event.streamed,
      usageComplete: event.usageComplete,
      stopReason: event.stopReason,
    });

    const r = schema.usageRollupHourly;
    const add = (col: AnyColumn) => sql`${col} + excluded.${sql.identifier(col.name)}`;
    await tx
      .insert(r)
      .values({
        bucketStart: new Date(Math.floor(occurredAt.getTime() / HOUR_MS) * HOUR_MS),
        orgId: event.orgId,
        userId: event.userId,
        virtualKeyId: event.virtualKeyId,
        provider: event.provider,
        model: event.model,
        requests: 1,
        incompleteRequests: event.usageComplete ? 0 : 1,
        inputTokens: BigInt(u.inputTokens),
        outputTokens: BigInt(u.outputTokens),
        cacheReadTokens: BigInt(u.cacheReadTokens),
        cacheWriteTokens: BigInt(u.cacheWrite5mTokens + u.cacheWrite1hTokens),
        costUsd: cost.costUsd,
      })
      .onConflictDoUpdate({
        target: [r.bucketStart, r.orgId, r.userId, r.virtualKeyId, r.provider, r.model],
        set: {
          requests: add(r.requests),
          incompleteRequests: add(r.incompleteRequests),
          inputTokens: add(r.inputTokens),
          outputTokens: add(r.outputTokens),
          cacheReadTokens: add(r.cacheReadTokens),
          cacheWriteTokens: add(r.cacheWriteTokens),
          costUsd: add(r.costUsd),
        },
      });
    await recordPromptAndDetectRetry(tx, event, cost.costUsd);
    return "inserted";
  });

  return { outcome, costPico: outcome === "inserted" ? cost.totalPico : 0n };
}
