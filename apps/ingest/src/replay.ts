/**
 * Re-runs stream entries through the normal ingest path without touching the
 * consumer group. Used to prove idempotency (replaying must not change the
 * row count) and to recover a window after a worker bug was fixed.
 *
 *   pnpm --filter @tokengrid/ingest replay [startId] [endId]
 */
import { count } from "drizzle-orm";
import { Redis } from "ioredis";
import { createDb, schema } from "@tokengrid/db";
import { USAGE_STREAM } from "@tokengrid/shared";
import { PriceCache } from "./prices.js";
import { processEntry, type EntryOutcome } from "./process.js";
import { toEntries } from "./stream.js";

const start = process.argv[2] ?? "-";
const end = process.argv[3] ?? "+";

const redisUrl = process.env.REDIS_URL;
if (!redisUrl) {
  console.error("REDIS_URL is required. See .env.example.");
  process.exit(1);
}
const redis = new Redis(redisUrl);
const { db, sql } = createDb(undefined, { max: 2 });

const rowCount = async () => (await db.select({ n: count() }).from(schema.usageEvents))[0]?.n ?? 0;

try {
  const prices = new PriceCache(db);
  await prices.load();
  const before = await rowCount();
  const tally: Record<EntryOutcome, number> = { inserted: 0, duplicate: 0, "dead-lettered": 0, retry: 0 };
  let cursor = start;
  for (;;) {
    const entries = toEntries(await redis.xrange(USAGE_STREAM, cursor, end, "COUNT", 500));
    if (entries.length === 0) break;
    for (const e of entries) {
      tally[await processEntry(db, prices, e.id, e.payload, 1, { warn: (o, m) => console.warn(m, o) })]++;
    }
    const last = entries[entries.length - 1];
    if (!last) break;
    cursor = `(${last.id}`;
  }
  const after = await rowCount();
  console.log(JSON.stringify({ usageEventsBefore: before, usageEventsAfter: after, outcomes: tally }, null, 2));
} finally {
  redis.disconnect();
  await sql.end();
}
