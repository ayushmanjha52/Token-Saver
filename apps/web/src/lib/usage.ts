import { createHmac } from "node:crypto";
import { and, desc, eq, gte, inArray, isNull, lt, sql } from "drizzle-orm";
import { schema, type Database } from "@tokengrid/db";
import { periodStart } from "@tokengrid/shared";
import type { Session } from "./session-token";
import type { DailyPoint, Figures, MeterRow, ModelLine, PeriodKey, SpendSplit, TeamRef, UsageResponse } from "./usage-types";
import { PERIODS } from "./usage-types";

export class UsageAccessError extends Error {
  override readonly name = "UsageAccessError";
  constructor(
    readonly status: 400 | 401 | 403 | 404,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Below this many other people with usage, anonymised rows identify people by
 * elimination ("the other row is obviously Sam"), so the team view shows the
 * aggregate only.
 */
export const MIN_ANONYMOUS_ROWS = 3;

const DAY_MS = 86_400_000;

export interface UsageQuery {
  view: "self" | "team" | "member";
  period: PeriodKey;
  teamId?: string;
  ref?: string;
}

export function parseUsageQuery(params: URLSearchParams): UsageQuery {
  const view = params.get("view") ?? "self";
  const period = params.get("period") ?? "30d";
  if (view !== "self" && view !== "team" && view !== "member") {
    throw new UsageAccessError(400, "bad_view", "view must be self, team or member");
  }
  if (!(PERIODS as readonly string[]).includes(period)) {
    throw new UsageAccessError(400, "bad_period", `period must be one of ${PERIODS.join(", ")}`);
  }
  const q: UsageQuery = { view, period: period as PeriodKey };
  const teamId = params.get("team");
  const ref = params.get("ref");
  if (teamId) q.teamId = teamId;
  if (ref) q.ref = ref;
  return q;
}

export function periodRange(key: PeriodKey, now: Date): { start: Date; end: Date } {
  const startOfToday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const end = new Date(startOfToday.getTime() + DAY_MS);
  if (key === "month") return { start: periodStart(now), end };
  const days = key === "7d" ? 7 : 30;
  return { start: new Date(end.getTime() - days * DAY_MS), end };
}

/**
 * Period-scoped pseudonym. Stable within one period so a row keeps its place
 * while the manager looks at it, but not linkable across periods, so
 * "Member 03" this month cannot be followed back through history.
 */
export function pseudonym(secret: string, teamId: string, period: PeriodKey, start: Date, userId: string): string {
  return createHmac("sha256", secret).update(`${teamId}|${period}|${start.toISOString()}|${userId}`).digest("base64url").slice(0, 22);
}

const ZERO: Figures = {
  requests: 0,
  incompleteRequests: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: "0",
};

function splitOf(f: Figures): SpendSplit {
  return { productiveUsd: null, wastedUsd: null, unclassifiedUsd: f.costUsd };
}

const r = schema.usageRollupHourly;
const figureColumns = {
  requests: sql<number>`coalesce(sum(${r.requests}), 0)::int`,
  incompleteRequests: sql<number>`coalesce(sum(${r.incompleteRequests}), 0)::int`,
  inputTokens: sql<number>`coalesce(sum(${r.inputTokens}), 0)::float8`,
  outputTokens: sql<number>`coalesce(sum(${r.outputTokens}), 0)::float8`,
  cacheReadTokens: sql<number>`coalesce(sum(${r.cacheReadTokens}), 0)::float8`,
  cacheWriteTokens: sql<number>`coalesce(sum(${r.cacheWriteTokens}), 0)::float8`,
  costUsd: sql<string>`coalesce(sum(${r.costUsd}), 0)::text`,
};

interface Viewer {
  id: string;
  orgId: string;
  displayName: string;
  orgRole: "member" | "admin";
}

async function loadViewer(db: Database, session: Session): Promise<Viewer> {
  const [u] = await db
    .select({ id: schema.users.id, orgId: schema.users.orgId, displayName: schema.users.displayName, orgRole: schema.users.orgRole })
    .from(schema.users)
    .where(and(eq(schema.users.id, session.userId), eq(schema.users.orgId, session.orgId)));
  if (!u) throw new UsageAccessError(401, "unknown_user", "Session user no longer exists.");
  return { ...u, orgRole: u.orgRole === "admin" ? "admin" : "member" };
}

async function viewerTeams(db: Database, v: Viewer): Promise<TeamRef[]> {
  const mine = await db
    .select({ id: schema.teams.id, name: schema.teams.name, role: schema.memberships.role })
    .from(schema.memberships)
    .innerJoin(schema.teams, eq(schema.teams.id, schema.memberships.teamId))
    .where(and(eq(schema.memberships.userId, v.id), eq(schema.teams.orgId, v.orgId)));
  const out = new Map<string, TeamRef>(
    mine.map((t) => [t.id, { id: t.id, name: t.name, access: t.role === "manager" ? "manager" : "member" }]),
  );
  if (v.orgRole === "admin") {
    const all = await db.select({ id: schema.teams.id, name: schema.teams.name }).from(schema.teams).where(eq(schema.teams.orgId, v.orgId));
    for (const t of all) if (out.get(t.id)?.access !== "manager") out.set(t.id, { id: t.id, name: t.name, access: "admin" });
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function hasActiveConsent(db: Database, userId: string): Promise<boolean> {
  const [c] = await db
    .select({ id: schema.drilldownConsents.id })
    .from(schema.drilldownConsents)
    .where(and(eq(schema.drilldownConsents.subjectUserId, userId), isNull(schema.drilldownConsents.revokedAt)));
  return c !== undefined;
}

function inPeriod(orgId: string, start: Date, end: Date) {
  return and(eq(r.orgId, orgId), gte(r.bucketStart, start), lt(r.bucketStart, end));
}

async function aggregate(db: Database, orgId: string, userIds: string[], start: Date, end: Date) {
  if (userIds.length === 0) return { totals: ZERO, daily: [] as DailyPoint[], models: [] as ModelLine[] };
  const where = and(inPeriod(orgId, start, end), inArray(r.userId, userIds));
  const [totals] = await db.select(figureColumns).from(r).where(where);
  const day = sql<string>`to_char(date_trunc('day', ${r.bucketStart} at time zone 'UTC'), 'YYYY-MM-DD')`;
  const daily = await db
    .select({ day, costUsd: figureColumns.costUsd, requests: figureColumns.requests })
    .from(r)
    .where(where)
    .groupBy(day)
    .orderBy(day);
  const models = await db
    .select({ model: r.model, requests: figureColumns.requests, costUsd: figureColumns.costUsd })
    .from(r)
    .where(where)
    .groupBy(r.model)
    .orderBy(desc(sql`sum(${r.costUsd})`));
  return { totals: totals ?? ZERO, daily, models };
}

async function perUser(db: Database, orgId: string, userIds: string[], start: Date, end: Date): Promise<Map<string, Figures>> {
  if (userIds.length === 0) return new Map();
  const rows = await db
    .select({ userId: r.userId, ...figureColumns })
    .from(r)
    .where(and(inPeriod(orgId, start, end), inArray(r.userId, userIds)))
    .groupBy(r.userId);
  return new Map(rows.map(({ userId, ...f }) => [userId, f]));
}

async function teamMembers(db: Database, orgId: string, teamId: string) {
  return db
    .select({ userId: schema.memberships.userId, displayName: schema.users.displayName })
    .from(schema.memberships)
    .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
    .innerJoin(schema.teams, eq(schema.teams.id, schema.memberships.teamId))
    .where(and(eq(schema.memberships.teamId, teamId), eq(schema.teams.orgId, orgId)));
}

async function writeAudit(
  db: Database,
  v: Viewer,
  action: string,
  subjectUserId: string | null,
  detail: Record<string, string>,
): Promise<void> {
  await db.insert(schema.auditLog).values({ orgId: v.orgId, actorUserId: v.id, subjectUserId, action, detail });
}

/**
 * Builds the /api/usage response, enforcing who may see what.
 *
 * - Self: always allowed; a person sees everything about their own usage,
 *   including who has looked at it.
 * - Team: managers of the team and org admins. Per-person rows are
 *   anonymous, ordered by pseudonym (never by spend, so the view cannot be
 *   read as a ranking), and suppressed entirely for small teams.
 * - Member: one named person. Requires team access plus that person's active
 *   consent, and the audit row is committed before any of their data is read.
 */
export async function getUsage(
  db: Database,
  session: Session,
  q: UsageQuery,
  secret: string,
  now = new Date(),
): Promise<UsageResponse> {
  const v = await loadViewer(db, session);
  const teams = await viewerTeams(db, v);
  const { start, end } = periodRange(q.period, now);
  const consented = await hasActiveConsent(db, v.id);
  const recent = await db
    .select({ at: schema.auditLog.createdAt, actor: schema.users.displayName })
    .from(schema.auditLog)
    .innerJoin(schema.users, eq(schema.users.id, schema.auditLog.actorUserId))
    .where(and(eq(schema.auditLog.subjectUserId, v.id), eq(schema.auditLog.action, "usage.drilldown")))
    .orderBy(desc(schema.auditLog.createdAt))
    .limit(10);

  const base = {
    viewer: {
      displayName: v.displayName,
      orgRole: v.orgRole,
      consented,
      teams,
      recentViews: recent.map((x) => ({ at: x.at.toISOString(), actor: x.actor })),
    },
    period: { key: q.period, start: start.toISOString(), end: end.toISOString() },
  };

  if (q.view === "self") {
    const agg = await aggregate(db, v.orgId, [v.id], start, end);
    const [b] = await db
      .select({ limitUsd: schema.budgets.limitUsd })
      .from(schema.budgets)
      .where(and(eq(schema.budgets.scope, "user"), eq(schema.budgets.scopeId, v.id)));
    let budget: UsageResponse["budget"] = null;
    if (b) {
      const [spent] = await db.select({ c: figureColumns.costUsd }).from(r).where(and(inPeriod(v.orgId, periodStart(now), end), eq(r.userId, v.id)));
      budget = { scope: "user", limitUsd: b.limitUsd, spentThisMonthUsd: spent?.c ?? "0" };
    }
    return {
      ...base,
      scope: { kind: "self" },
      totals: agg.totals,
      split: splitOf(agg.totals),
      rows: [{ ref: "self", label: v.displayName, isViewer: true, drilldownAllowed: consented, figures: agg.totals, split: splitOf(agg.totals) }],
      daily: agg.daily,
      models: agg.models,
      budget,
    };
  }

  if (!q.teamId) throw new UsageAccessError(400, "missing_team", "team is required for team and member views");
  const team = teams.find((t) => t.id === q.teamId);
  // Members of a team get the same 403 as strangers to it: the team view
  // is for managers, and a different error would reveal team existence.
  if (!team || team.access === "member") {
    throw new UsageAccessError(403, "forbidden", "Team views are available to the team's managers and org admins.");
  }
  const members = await teamMembers(db, v.orgId, team.id);
  const ids = members.map((m) => m.userId);
  const consentRows = ids.length
    ? await db
        .select({ userId: schema.drilldownConsents.subjectUserId })
        .from(schema.drilldownConsents)
        .where(and(inArray(schema.drilldownConsents.subjectUserId, ids), isNull(schema.drilldownConsents.revokedAt)))
    : [];
  const consenting = new Set(consentRows.map((c) => c.userId));
  const refOf = (userId: string) => pseudonym(secret, team.id, q.period, start, userId);

  if (q.view === "member") {
    const subject = q.ref ? members.find((m) => refOf(m.userId) === q.ref) : undefined;
    if (!subject) throw new UsageAccessError(404, "unknown_member", "No such member in this team for this period.");
    if (!consenting.has(subject.userId)) {
      throw new UsageAccessError(403, "no_consent", "This person has not allowed individual drill-down.");
    }
    // Audit first. If this insert fails, the request fails, and nothing about
    // the person has been read.
    await writeAudit(db, v, "usage.drilldown", subject.userId, { teamId: team.id, period: q.period, start: start.toISOString() });
    const agg = await aggregate(db, v.orgId, [subject.userId], start, end);
    return {
      ...base,
      scope: { kind: "member", teamId: team.id, teamName: team.name, displayName: subject.displayName },
      totals: agg.totals,
      split: splitOf(agg.totals),
      rows: [
        { ref: q.ref ?? "", label: subject.displayName, isViewer: false, drilldownAllowed: true, figures: agg.totals, split: splitOf(agg.totals) },
      ],
      daily: agg.daily,
      models: agg.models,
      budget: null,
    };
  }

  await writeAudit(db, v, "usage.team_view", null, { teamId: team.id, period: q.period, start: start.toISOString() });
  const agg = await aggregate(db, v.orgId, ids, start, end);
  const byUser = await perUser(db, v.orgId, ids, start, end);
  const others = members.filter((m) => m.userId !== v.id && byUser.has(m.userId));
  const rowsSuppressed = others.length < MIN_ANONYMOUS_ROWS;
  const rows: MeterRow[] = [];
  const own = byUser.get(v.id);
  if (own) rows.push({ ref: refOf(v.id), label: "You", isViewer: true, drilldownAllowed: consented, figures: own, split: splitOf(own) });
  if (!rowsSuppressed) {
    const anon = others.map((m) => ({ m, ref: refOf(m.userId) })).sort((a, b) => a.ref.localeCompare(b.ref));
    anon.forEach(({ m, ref }, i) => {
      const f = byUser.get(m.userId) ?? ZERO;
      rows.push({
        ref,
        label: `Member ${String(i + 1).padStart(2, "0")}`,
        isViewer: false,
        drilldownAllowed: consenting.has(m.userId),
        figures: f,
        split: splitOf(f),
      });
    });
  }
  return {
    ...base,
    scope: { kind: "team", teamId: team.id, teamName: team.name, memberCount: members.length, rowsSuppressed },
    totals: agg.totals,
    split: splitOf(agg.totals),
    rows,
    daily: agg.daily,
    models: agg.models,
    budget: null,
  };
}

/** Grants or revokes the viewer's own drill-down consent. Only ever acts on the session's own user. */
export async function setConsent(db: Database, session: Session, grant: boolean): Promise<boolean> {
  const v = await loadViewer(db, session);
  if (grant) {
    await db.insert(schema.drilldownConsents).values({ orgId: v.orgId, subjectUserId: v.id }).onConflictDoNothing();
  } else {
    await db
      .update(schema.drilldownConsents)
      .set({ revokedAt: new Date() })
      .where(and(eq(schema.drilldownConsents.subjectUserId, v.id), isNull(schema.drilldownConsents.revokedAt)));
  }
  await writeAudit(db, v, grant ? "consent.granted" : "consent.revoked", v.id, {});
  return grant;
}
