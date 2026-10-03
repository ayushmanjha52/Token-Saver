import { and, desc, eq, gte, isNull, sql } from "drizzle-orm";
import { schema, type Database } from "@tokengrid/db";
import type { Session } from "./session-token";
import { UsageAccessError } from "./usage";

export interface DriftDay {
  day: string;
  provider: string;
  providerUsd: string;
  meteredUsd: string;
  /** Null when the provider billed nothing that day. */
  driftRatio: number | null;
  driftedModels: number;
}

export interface DriftLine {
  day: string;
  provider: string;
  model: string;
  providerUsd: string;
  meteredUsd: string;
  driftRatio: number | null;
}

export interface AlertView {
  id: string;
  kind: string;
  message: string;
  createdAt: string;
  acknowledgedAt: string | null;
}

export interface ReconciliationView {
  days: DriftDay[];
  drifted: DriftLine[];
  alerts: AlertView[];
  threshold: number;
}

async function requireAdmin(db: Database, session: Session): Promise<void> {
  const [u] = await db
    .select({ role: schema.users.orgRole })
    .from(schema.users)
    .where(and(eq(schema.users.id, session.userId), eq(schema.users.orgId, session.orgId)));
  if (!u) throw new UsageAccessError(401, "unknown_user", "Session user no longer exists.");
  if (u.role !== "admin") throw new UsageAccessError(403, "forbidden", "Reconciliation is visible to org admins.");
}

/** Org-level only: reconciliation compares bills, it never names a person. */
export async function getReconciliation(db: Database, session: Session, days = 30, now = new Date()): Promise<ReconciliationView> {
  await requireAdmin(db, session);
  const since = new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 10);
  const t = schema.reconciliations;
  const daily = await db
    .select({
      day: t.day,
      provider: t.provider,
      providerUsd: sql<string>`sum(${t.providerUsd})::text`,
      meteredUsd: sql<string>`sum(${t.meteredUsd})::text`,
      driftedModels: sql<number>`count(*) filter (where ${t.status} = 'drift')::int`,
    })
    .from(t)
    .where(and(eq(t.orgId, session.orgId), gte(t.day, since)))
    .groupBy(t.day, t.provider)
    .orderBy(t.day);
  const drifted = await db
    .select()
    .from(t)
    .where(and(eq(t.orgId, session.orgId), gte(t.day, since), eq(t.status, "drift")))
    .orderBy(desc(t.day));
  const a = schema.alerts;
  const alerts = await db
    .select()
    .from(a)
    .where(eq(a.orgId, session.orgId))
    .orderBy(sql`${a.acknowledgedAt} is not null`, desc(a.createdAt))
    .limit(50);
  return {
    threshold: 0.02,
    days: daily.map((d) => {
      const p = Number(d.providerUsd);
      return { ...d, driftRatio: p > 0 ? (Number(d.meteredUsd) - p) / p : null };
    }),
    drifted: drifted.map((d) => ({
      day: d.day,
      provider: d.provider,
      model: d.model,
      providerUsd: d.providerUsd,
      meteredUsd: d.meteredUsd,
      driftRatio: d.driftRatio === null ? null : Number(d.driftRatio),
    })),
    alerts: alerts.map((x) => ({ id: x.id, kind: x.kind, message: x.message, createdAt: x.createdAt.toISOString(), acknowledgedAt: x.acknowledgedAt?.toISOString() ?? null })),
  };
}

export async function acknowledgeAlert(db: Database, session: Session, alertId: string): Promise<void> {
  await requireAdmin(db, session);
  await db
    .update(schema.alerts)
    .set({ acknowledgedAt: new Date() })
    .where(and(eq(schema.alerts.id, alertId), eq(schema.alerts.orgId, session.orgId), isNull(schema.alerts.acknowledgedAt)));
  await db.insert(schema.auditLog).values({ orgId: session.orgId, actorUserId: session.userId, subjectUserId: null, action: "alert.acknowledged", detail: { alertId } });
}
