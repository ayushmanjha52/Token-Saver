/**
 * Reconciles one UTC day (default: yesterday) against provider cost reports.
 *
 *   pnpm --filter @tokengrid/ingest reconcile [--day 2026-10-02]
 */
import { parseArgs } from "node:util";
import { createDb } from "@tokengrid/db";
import { InvariantViolationError } from "@tokengrid/shared";
import { costSources } from "./providers/cost-sources.js";
import { reconcileDay, webhookSink } from "./reconcile.js";

const { values } = parseArgs({ options: { day: { type: "string" } } });
const day = values.day ? new Date(`${values.day}T00:00:00Z`) : new Date(Date.now() - 86_400_000);
if (Number.isNaN(day.getTime())) throw new InvariantViolationError(`--day must be YYYY-MM-DD, got ${values.day}`);

const log = { warn: (o: object, m: string) => console.warn(m, o) };
const { db, sql } = createDb(undefined, { max: 2 });
try {
  const rows = await reconcileDay(db, costSources(), day, webhookSink(process.env.ALERT_WEBHOOK_URL, log), log);
  for (const r of rows) {
    const pct = r.driftRatio === null ? "n/a" : `${(r.driftRatio * 100).toFixed(2)}%`;
    console.log(`${r.status.padEnd(5)} ${r.provider.padEnd(9)} ${r.day} ${r.model.padEnd(24)} provider $${r.providerUsd.toFixed(4)}  metered $${r.meteredUsd.toFixed(4)}  drift ${pct}`);
  }
  if (rows.length === 0) console.log("nothing to reconcile: no org has an admin credential, or no usage on either side");
  if (rows.some((r) => r.status === "drift")) process.exitCode = 2;
} finally {
  await sql.end();
}
