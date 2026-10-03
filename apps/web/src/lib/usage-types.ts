/** Wire types for /api/usage. Imported by client components, so nothing server-only here. */

export const PERIODS = ["7d", "30d", "month"] as const;
export type PeriodKey = (typeof PERIODS)[number];

export interface Figures {
  requests: number;
  /** Requests whose stream ended before final usage arrived; output counts for these are floors. */
  incompleteRequests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Exact decimal string, USD. */
  costUsd: string;
}

/**
 * Spend split by what it achieved. Only `unclassifiedUsd` is populated until
 * waste detection exists: calling unmeasured spend "productive" would be a
 * score component with no measured input.
 */
export interface SpendSplit {
  productiveUsd: string | null;
  wastedUsd: string | null;
  unclassifiedUsd: string;
}

export interface MeterRow {
  /** Opaque, period-scoped handle used to request a drill-down. Never a user id. */
  ref: string;
  label: string;
  isViewer: boolean;
  /** True when this person has allowed managers to see their individual usage. */
  drilldownAllowed: boolean;
  figures: Figures;
  split: SpendSplit;
}

export interface DailyPoint {
  day: string;
  costUsd: string;
  requests: number;
}

export interface ModelLine {
  model: string;
  requests: number;
  costUsd: string;
}

export interface TeamRef {
  id: string;
  name: string;
  /** How the viewer relates to the team: managers and admins can open the team view. */
  access: "member" | "manager" | "admin";
}

export interface UsageResponse {
  viewer: {
    displayName: string;
    orgRole: "member" | "admin";
    consented: boolean;
    teams: TeamRef[];
    /** Who has opened this person's individual usage recently. Members always see this. */
    recentViews: { at: string; actor: string }[];
  };
  period: { key: PeriodKey; start: string; end: string };
  scope:
    | { kind: "self" }
    | { kind: "team"; teamId: string; teamName: string; memberCount: number; rowsSuppressed: boolean }
    | { kind: "member"; teamId: string; teamName: string; displayName: string };
  totals: Figures;
  split: SpendSplit;
  rows: MeterRow[];
  daily: DailyPoint[];
  models: ModelLine[];
  /** The viewer's own monthly limit, shown only in their self view. */
  budget: { scope: "user"; limitUsd: string; spentThisMonthUsd: string } | null;
}

export interface UsageError {
  error: { code: string; message: string };
}
