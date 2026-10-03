import { schema, type Database } from "@tokengrid/db";
import {
  InvalidUsageEventError,
  parseUsageEvent,
  PriceNotFoundError,
  UnpricedUsageError,
  type UsageEventV1,
} from "@tokengrid/shared";
import { ingestEvent, type IngestOutcome, type IngestResult } from "./ingest.js";
import type { PriceCache } from "./prices.js";
import type { SpendCounters } from "./spend.js";
import { lintRequest } from "./efficiency.js";

export type EntryOutcome = IngestOutcome | "dead-lettered" | "retry";

/** After this many deliveries an entry that keeps failing transiently is treated as poison. */
export const MAX_DELIVERIES = 10;

/**
 * Postgres SQLSTATE classes that will fail the same way on every retry:
 * 22 data exception (e.g. integer overflow), 23 integrity violation
 * (unknown org/user/key, no partition for the row's month).
 */
function isPermanentDbError(err: unknown): boolean {
  // Drizzle wraps driver errors (DrizzleQueryError) and keeps the SQLSTATE on
  // `cause`; checking only the top level classifies every integrity failure
  // as transient and redelivers it until MAX_DELIVERIES.
  for (let e: unknown = err, depth = 0; typeof e === "object" && e !== null && depth < 5; depth++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string" && /^(22|23)[0-9A-Z]{3}$/.test(code)) return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

function isPermanent(err: unknown): boolean {
  return (
    err instanceof InvalidUsageEventError ||
    err instanceof PriceNotFoundError ||
    err instanceof UnpricedUsageError ||
    isPermanentDbError(err)
  );
}

/**
 * Puts the root cause first: Drizzle's wrapper message is the failed SQL,
 * while the reason someone triaging the DLQ needs ("no partition of relation
 * found for row") is on the innermost cause.
 */
export function describeError(err: unknown): { errorName: string; errorMessage: string } {
  if (!(err instanceof Error)) return { errorName: "UnknownError", errorMessage: String(err) };
  let root: Error = err;
  for (let depth = 0; root.cause instanceof Error && depth < 5; depth++) root = root.cause;
  const code = (root as { code?: unknown }).code;
  const reason = `${root.message}${typeof code === "string" ? ` [SQLSTATE ${code}]` : ""}`;
  const errorMessage = root === err ? reason : `${reason} | ${err.message.split("\n")[0] ?? ""}`;
  return { errorName: err.name, errorMessage };
}

export async function deadLetter(db: Database, entryId: string, payload: string, err: unknown): Promise<void> {
  const { errorName, errorMessage } = describeError(err);
  await db
    .insert(schema.usageDlq)
    .values({ streamEntryId: entryId, payload, errorName, errorMessage })
    .onConflictDoNothing();
}

/**
 * Decides an entry's fate. Returning anything other than "retry" means the
 * caller may XACK: the event is either stored, already stored, or durably in
 * the DLQ. "retry" leaves it pending so another delivery picks it up.
 */
export async function processEntry(
  db: Database,
  prices: PriceCache,
  entryId: string,
  payload: string,
  deliveries: number,
  log: { warn: (obj: object, msg: string) => void },
  counters?: SpendCounters,
  touchedUsers?: Map<string, string>,
): Promise<EntryOutcome> {
  let event: UsageEventV1;
  let result: IngestResult;
  try {
    event = parseUsageEvent(payload);
    result = await ingestEvent(db, prices, event);
  } catch (err) {
    if (!isPermanent(err) && deliveries < MAX_DELIVERIES) {
      log.warn({ err, entryId, deliveries }, "transient ingest failure; will redeliver");
      return "retry";
    }
    try {
      await deadLetter(db, entryId, payload, err);
      log.warn({ err, entryId }, "event dead-lettered");
      return "dead-lettered";
    } catch (dlqErr) {
      // Cannot write the DLQ either (Postgres is down): keep the entry pending.
      log.warn({ err: dlqErr, entryId }, "dead-letter write failed; will redeliver");
      return "retry";
    }
  }
  if (result.outcome === "inserted") {
    // Lint findings and scores are derived data, rebuilt on the next matching
    // request or score pass, so their failures never cause a redelivery.
    await lintRequest(db, prices, event).catch((err: unknown) => log.warn({ err, entryId }, "lint failed"));
    touchedUsers?.set(event.userId, event.orgId);
  }
  if (counters && result.outcome === "inserted") {
    // Best effort: the event is already durable, and a missed increment is
    // repaired by the periodic rollup sync. Failing here must not trigger a
    // redelivery, which would be a duplicate and could not re-add anyway.
    await counters.add(event, result.costPico).catch((err: unknown) => log.warn({ err, entryId }, "spend counter update failed"));
  }
  return result.outcome;
}
