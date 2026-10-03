/**
 * Retries unresolved dead-lettered events, e.g. after adding the missing
 * price row that sent them there. Idempotent: an event that was ingested by
 * another path in the meantime resolves as a duplicate.
 *
 *   pnpm --filter @tokengrid/ingest redrive
 */
import { eq, isNull } from "drizzle-orm";
import { createDb, schema } from "@tokengrid/db";
import { parseUsageEvent } from "@tokengrid/shared";
import { ingestEvent } from "./ingest.js";
import { PriceCache } from "./prices.js";
import { describeError } from "./process.js";

const { db, sql } = createDb(undefined, { max: 2 });
try {
  const prices = new PriceCache(db);
  await prices.load();
  const rows = await db.select().from(schema.usageDlq).where(isNull(schema.usageDlq.resolvedAt));
  let resolved = 0;
  for (const row of rows) {
    try {
      await ingestEvent(db, prices, parseUsageEvent(row.payload));
      await db.update(schema.usageDlq).set({ resolvedAt: new Date() }).where(eq(schema.usageDlq.id, row.id));
      resolved++;
    } catch (err) {
      await db.update(schema.usageDlq).set(describeError(err)).where(eq(schema.usageDlq.id, row.id));
    }
  }
  console.log(JSON.stringify({ unresolved: rows.length, resolved, stillFailing: rows.length - resolved }));
} finally {
  await sql.end();
}
