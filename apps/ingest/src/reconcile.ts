import { and, eq, gte, isNull, lt, sql } from "drizzle-orm";
import { decryptSecret, schema, type Database } from "@tokengrid/db";
import { PROVIDERS, type Provider } from "@tokengrid/shared";
import type { CostSource } from "./providers/cost-sources.js";

/** Drift above this share of the provider's bill raises an alert. */
export const DRIFT_THRESHOLD = 0.02;
/**
 * Below a tenth of a cent of absolute difference, a large ratio is rounding
 * on a near-empty day, not a metering bug. Both sides are exact well below
 * this (cost reports carry fractional cents; metering is in pico-dollars),
 * so the floor can be this low; a cent would hide a 5% bug on any day under
 * $0.20 of spend.
 */
export const DRIFT_FLOOR_USD = 0.001;

export interface ReconcileRow {
  orgId: string;
  provider: Provider;
  day: string;
  model: string;
  providerUsd: number;
  meteredUsd: number;
  driftRatio: number | null;
  status: "ok" | "drift";
}

export interface AlertSink {
  deliver(alert: { orgId: string; kind: string; message: string; detail: Record<string, unknown> }): Promise<void>;
}

/** Posts to ALERT_WEBHOOK_URL when configured (Slack-compatible `text`); a failed delivery never fails the run. */
export function webhookSink(url: string | undefined, log: { warn: (o: object, m: string) => void }): AlertSink {
  return {
    async deliver(alert) {
      if (!url) return;
      try {
        await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: alert.message, alert }),
          signal: AbortSignal.timeout(5_000),
        });
      } catch (err) {
        log.warn({ err }, "alert webhook delivery failed");
      }
    },
  };
}

export function classify(providerUsd: number, meteredUsd: number): Pick<ReconcileRow, "driftRatio" | "status"> {
  const diff = meteredUsd - providerUsd;
  const driftRatio = providerUsd > 0 ? diff / providerUsd : null;
  const material = Math.abs(diff) >= DRIFT_FLOOR_USD;
  const drifted = material && (driftRatio === null || Math.abs(driftRatio) > DRIFT_THRESHOLD);
  return { driftRatio, status: drifted ? "drift" : "ok" };
}

function money(usd: number): string {
  return `$${usd.toFixed(2)}`;
}

/**
 * Compares one UTC day of provider billing with TokenGrid's metered cost,
 * per org, provider and model, for every org that has stored an admin key.
 * Re-running a day overwrites its rows; an alert is raised once per drifted
 * model and day.
 */
export async function reconcileDay(
  db: Database,
  sources: readonly CostSource[],
  day: Date,
  sink: AlertSink,
  log: { warn: (o: object, m: string) => void },
): Promise<ReconcileRow[]> {
  const start = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()));
  const end = new Date(start.getTime() + 86_400_000);
  const dayStr = start.toISOString().slice(0, 10);
  const pc = schema.providerCredentials;
  const creds = await db
    .select({ orgId: pc.orgId, provider: pc.provider, scope: pc.reconcileScope, ciphertext: pc.ciphertext })
    .from(pc)
    .where(and(eq(pc.kind, "admin"), isNull(pc.revokedAt)));

  const rows: ReconcileRow[] = [];
  for (const cred of creds) {
    const source = sources.find((s) => s.provider === cred.provider);
    if (!source || !(PROVIDERS as readonly string[]).includes(cred.provider)) continue;
    const provider = cred.provider as Provider;
    let billed: Map<string, number>;
    try {
      const adminKey = await decryptSecret(cred.ciphertext, { orgId: cred.orgId, provider: `${provider}#admin` });
      billed = await source.dailyCostByModel(adminKey, cred.scope, start);
    } catch (err) {
      log.warn({ err, orgId: cred.orgId, provider }, "cost report unavailable; day left unreconciled");
      continue;
    }

    const r = schema.usageRollupHourly;
    const metered = await db
      .select({ model: r.model, usd: sql<string>`sum(${r.costUsd})::text` })
      .from(r)
      .where(and(eq(r.orgId, cred.orgId), eq(r.provider, provider), gte(r.bucketStart, start), lt(r.bucketStart, end)))
      .groupBy(r.model);
    const ours = new Map(metered.map((m) => [m.model, Number(m.usd)]));

    for (const model of new Set([...billed.keys(), ...ours.keys()])) {
      const providerUsd = billed.get(model) ?? 0;
      const meteredUsd = ours.get(model) ?? 0;
      const row: ReconcileRow = { orgId: cred.orgId, provider, day: dayStr, model, providerUsd, meteredUsd, ...classify(providerUsd, meteredUsd) };
      rows.push(row);
      const values = {
        orgId: row.orgId,
        provider,
        day: dayStr,
        model,
        providerUsd: providerUsd.toFixed(6),
        meteredUsd: meteredUsd.toFixed(6),
        driftRatio: row.driftRatio === null ? null : row.driftRatio.toFixed(6),
        status: row.status,
        checkedAt: new Date(),
      };
      const t = schema.reconciliations;
      await db.insert(t).values(values).onConflictDoUpdate({ target: [t.orgId, t.provider, t.day, t.model], set: values });

      if (row.status !== "drift") continue;
      const pct = row.driftRatio === null ? "provider billed nothing" : `${row.driftRatio > 0 ? "+" : ""}${(row.driftRatio * 100).toFixed(1)}%`;
      const message = `Metering drift on ${provider} ${model} for ${dayStr}: TokenGrid metered ${money(meteredUsd)}, provider billed ${money(providerUsd)} (${pct}).`;
      const detail = { provider, model, day: dayStr, providerUsd, meteredUsd, driftRatio: row.driftRatio };
      const inserted = await db
        .insert(schema.alerts)
        .values({ orgId: row.orgId, kind: "reconciliation_drift", dedupeKey: `recon:${provider}:${dayStr}:${model}`, message, detail })
        .onConflictDoNothing()
        .returning({ id: schema.alerts.id });
      if (inserted.length > 0) {
        log.warn(detail, message);
        await sink.deliver({ orgId: row.orgId, kind: "reconciliation_drift", message, detail });
      }
    }
  }
  return rows;
}
