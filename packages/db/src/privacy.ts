import { createHash, randomBytes } from "node:crypto";
import { and, asc, eq, gt, lt, or, sql } from "drizzle-orm";
import { InvariantViolationError } from "@tokengrid/shared";
import type { Database } from "./client.js";
import * as s from "./schema.js";

const DAY_MS = 86_400_000;
/** Who looked at whose data is kept for at least a year even under shorter retention, so access can still be questioned. */
export const AUDIT_MIN_RETENTION_DAYS = 365;

export class UnknownUserError extends Error {
  override readonly name = "UnknownUserError";
  constructor(userId: string) {
    super(`No user ${userId}`);
  }
}

/** postgres-js reports affected rows as `count` on the result of a write. */
async function rowCount(q: PromiseLike<unknown>): Promise<number> {
  const r = (await q) as { count?: unknown };
  return typeof r.count === "number" ? r.count : 0;
}

export interface RetentionReport {
  orgId: string;
  cutoff: string;
  deleted: Record<string, number>;
}

/**
 * Deletes per-person usage detail older than each org's retention_days.
 * Rollups are per-person too, so they go as well; aggregates the org still
 * needs past the cutoff are its own exports to keep.
 */
export async function applyRetention(db: Database, now = new Date()): Promise<RetentionReport[]> {
  const orgs = await db.select({ id: s.organizations.id, days: s.organizations.retentionDays }).from(s.organizations);
  const reports: RetentionReport[] = [];
  for (const org of orgs) {
    const cutoff = new Date(now.getTime() - org.days * DAY_MS);
    const auditCutoff = new Date(now.getTime() - Math.max(org.days, AUDIT_MIN_RETENTION_DAYS) * DAY_MS);
    const n = rowCount;
    const deleted = {
      usageEvents: await n(db.delete(s.usageEvents).where(and(eq(s.usageEvents.orgId, org.id), lt(s.usageEvents.occurredAt, cutoff)))),
      rollups: await n(db.delete(s.usageRollupHourly).where(and(eq(s.usageRollupHourly.orgId, org.id), lt(s.usageRollupHourly.bucketStart, cutoff)))),
      promptFeatures: await n(db.delete(s.promptFeatures).where(and(eq(s.promptFeatures.orgId, org.id), lt(s.promptFeatures.occurredAt, cutoff)))),
      retries: await n(db.delete(s.retries).where(and(eq(s.retries.orgId, org.id), lt(s.retries.discardedAt, cutoff)))),
      lintFindings: await n(db.delete(s.lintFindings).where(and(eq(s.lintFindings.orgId, org.id), lt(s.lintFindings.lastSeen, cutoff)))),
      scores: await n(
        db.delete(s.efficiencyScores).where(and(eq(s.efficiencyScores.orgId, org.id), lt(s.efficiencyScores.asOfDay, cutoff.toISOString().slice(0, 10)))),
      ),
      auditLog: await n(db.delete(s.auditLog).where(and(eq(s.auditLog.orgId, org.id), lt(s.auditLog.createdAt, auditCutoff)))),
    };
    reports.push({ orgId: org.id, cutoff: cutoff.toISOString(), deleted });
  }
  return reports;
}

const PLACEHOLDER_NAME = "Former member";

/**
 * Deletes one person's usage data on request.
 *
 * Their hourly rollups are folded into an org-level "Former member"
 * placeholder rather than deleted: the org's totals, budgets and the
 * provider reconciliation must still add up, but nothing ties those figures
 * to the person any more. Raw events, prompt features, retries, findings,
 * scores, consents, and the record of who viewed them are deleted. The
 * idempotency ledger is kept (it holds no personal data), so a stray replay
 * cannot re-insert a deleted event.
 */
export async function deleteUserData(db: Database, userId: string, requestedBy: string): Promise<Record<string, number>> {
  return db.transaction(async (tx) => {
    const [user] = await tx.select({ id: s.users.id, orgId: s.users.orgId }).from(s.users).where(eq(s.users.id, userId));
    if (!user) throw new UnknownUserError(userId);
    const email = `former-members@${user.orgId}.tokengrid.invalid`;
    await tx.insert(s.users).values({ orgId: user.orgId, email, displayName: PLACEHOLDER_NAME }).onConflictDoNothing();
    const [ph] = await tx.select({ id: s.users.id }).from(s.users).where(and(eq(s.users.orgId, user.orgId), eq(s.users.email, email)));
    if (!ph) throw new InvariantViolationError("placeholder user missing after upsert");
    if (ph.id === userId) throw new InvariantViolationError("refusing to delete the placeholder itself");
    let [phKey] = await tx.select({ id: s.virtualKeys.id }).from(s.virtualKeys).where(eq(s.virtualKeys.userId, ph.id));
    if (!phKey) {
      // A key that can never authenticate: its hash is of random bytes nobody holds, and it is revoked.
      [phKey] = await tx
        .insert(s.virtualKeys)
        .values({
          orgId: user.orgId,
          userId: ph.id,
          name: "former-members",
          keyPrefix: "tgk_former",
          keyHash: createHash("sha256").update(randomBytes(32)).digest("hex"),
          revokedAt: new Date(),
        })
        .returning({ id: s.virtualKeys.id });
    }
    if (!phKey) throw new InvariantViolationError("placeholder key insert returned nothing");

    const moved = await tx.execute(sql`
      insert into usage_rollup_hourly (bucket_start, org_id, user_id, virtual_key_id, provider, model, requests, incomplete_requests,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, retried_requests, wasted_cost_usd)
      select bucket_start, org_id, ${ph.id}, ${phKey.id}, provider, model, sum(requests), sum(incomplete_requests),
        sum(input_tokens), sum(output_tokens), sum(cache_read_tokens), sum(cache_write_tokens), sum(cost_usd), sum(retried_requests), sum(wasted_cost_usd)
      from usage_rollup_hourly where user_id = ${userId}
      group by bucket_start, org_id, provider, model
      on conflict (bucket_start, org_id, user_id, virtual_key_id, provider, model) do update set
        requests = usage_rollup_hourly.requests + excluded.requests,
        incomplete_requests = usage_rollup_hourly.incomplete_requests + excluded.incomplete_requests,
        input_tokens = usage_rollup_hourly.input_tokens + excluded.input_tokens,
        output_tokens = usage_rollup_hourly.output_tokens + excluded.output_tokens,
        cache_read_tokens = usage_rollup_hourly.cache_read_tokens + excluded.cache_read_tokens,
        cache_write_tokens = usage_rollup_hourly.cache_write_tokens + excluded.cache_write_tokens,
        cost_usd = usage_rollup_hourly.cost_usd + excluded.cost_usd,
        retried_requests = usage_rollup_hourly.retried_requests + excluded.retried_requests,
        wasted_cost_usd = usage_rollup_hourly.wasted_cost_usd + excluded.wasted_cost_usd`);
    const count = (r: unknown) => ((r as { count?: unknown }).count as number | undefined) ?? 0;
    const deleted = {
      rollupsReassigned: count(moved),
      rollups: count(await tx.delete(s.usageRollupHourly).where(eq(s.usageRollupHourly.userId, userId))),
      usageEvents: count(await tx.delete(s.usageEvents).where(eq(s.usageEvents.userId, userId))),
      promptFeatures: count(await tx.delete(s.promptFeatures).where(eq(s.promptFeatures.userId, userId))),
      retries: count(await tx.delete(s.retries).where(eq(s.retries.userId, userId))),
      lintFindings: count(await tx.delete(s.lintFindings).where(eq(s.lintFindings.userId, userId))),
      scores: count(await tx.delete(s.efficiencyScores).where(eq(s.efficiencyScores.userId, userId))),
      consents: count(await tx.delete(s.drilldownConsents).where(eq(s.drilldownConsents.subjectUserId, userId))),
      viewsOfThem: count(await tx.delete(s.auditLog).where(eq(s.auditLog.subjectUserId, userId))),
    };
    // The deletion itself is recorded without naming whose data it was.
    await tx.insert(s.auditLog).values({ orgId: user.orgId, actorUserId: requestedBy, subjectUserId: null, action: "data.deleted", detail: deleted });
    return deleted;
  });
}

/**
 * Everything TokenGrid holds about one person, as a sequence of typed
 * records for streaming to NDJSON. Raw events are paged by (occurred_at, id)
 * so a year of usage never sits in memory at once.
 */
export async function* exportUserData(db: Database, userId: string): AsyncGenerator<Record<string, unknown>> {
  const [user] = await db.select().from(s.users).where(eq(s.users.id, userId));
  if (!user) throw new UnknownUserError(userId);
  yield { type: "profile", exportedAt: new Date().toISOString(), id: user.id, email: user.email, displayName: user.displayName, orgRole: user.orgRole, createdAt: user.createdAt };
  for (const c of await db.select().from(s.drilldownConsents).where(eq(s.drilldownConsents.subjectUserId, userId))) yield { type: "consent", ...c };
  for (const k of await db
    .select({ id: s.virtualKeys.id, name: s.virtualKeys.name, keyPrefix: s.virtualKeys.keyPrefix, createdAt: s.virtualKeys.createdAt, revokedAt: s.virtualKeys.revokedAt })
    .from(s.virtualKeys)
    .where(eq(s.virtualKeys.userId, userId)))
    yield { type: "virtual_key", ...k };
  for (const b of await db.select().from(s.budgets).where(and(eq(s.budgets.scope, "user"), eq(s.budgets.scopeId, userId)))) yield { type: "budget", ...b };
  for (const r of await db.select().from(s.efficiencyScores).where(eq(s.efficiencyScores.userId, userId))) yield { type: "efficiency_score", ...r };
  for (const r of await db.select().from(s.lintFindings).where(eq(s.lintFindings.userId, userId))) yield { type: "lint_finding", ...r };
  for (const r of await db.select().from(s.retries).where(eq(s.retries.userId, userId))) yield { type: "retry", ...r };
  const audit = await db
    .select({ at: s.auditLog.createdAt, action: s.auditLog.action, actor: s.users.displayName, detail: s.auditLog.detail, subjectUserId: s.auditLog.subjectUserId })
    .from(s.auditLog)
    .innerJoin(s.users, eq(s.users.id, s.auditLog.actorUserId))
    .where(or(eq(s.auditLog.subjectUserId, userId), eq(s.auditLog.actorUserId, userId)));
  for (const a of audit) yield { type: a.subjectUserId === userId ? "viewed_by" : "my_access", at: a.at, action: a.action, actor: a.actor, detail: a.detail };

  const e = s.usageEvents;
  let after: { at: Date; id: string } | null = null;
  for (;;) {
    const page: (typeof e.$inferSelect)[] = await db
      .select()
      .from(e)
      .where(
        after
          ? and(eq(e.userId, userId), or(gt(e.occurredAt, after.at), and(eq(e.occurredAt, after.at), gt(e.id, after.id))))
          : eq(e.userId, userId),
      )
      .orderBy(asc(e.occurredAt), asc(e.id))
      .limit(2000);
    for (const ev of page) yield { type: "usage_event", ...ev };
    const last = page[page.length - 1];
    if (!last || page.length < 2000) break;
    after = { at: last.occurredAt, id: last.id };
  }
}
