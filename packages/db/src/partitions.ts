import { sql } from "drizzle-orm";
import type { Database } from "./client.js";

/**
 * Creates monthly partitions from last month through `monthsAhead`. Last
 * month is included because a redelivered or redriven event can arrive after
 * the boundary; without its partition the insert fails.
 */
export async function ensureUsagePartitions(db: Database, monthsAhead = 2): Promise<void> {
  await db.execute(sql`select tokengrid_ensure_usage_partitions(${monthsAhead})`);
}
