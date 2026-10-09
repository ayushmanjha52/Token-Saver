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
  /** Requests whose response was discarded because the same prompt was re-sent. */
  retriedRequests: number;
  /** Cost of those discarded responses, charged to the hour they ran. */
  wastedUsd: string;
}

/**
 * Spend split by what happened to it. `wastedUsd` is spend on responses that
 * were thrown away and re-requested; `productiveUsd` is everything kept.
 * "Kept" is all that is claimed for it: there is no acceptance signal yet to
 * say a kept response was used.
 */
export interface SpendSplit {
  productiveUsd: string | null;
  wastedUsd: string | null;
  unclassifiedUsd: string;
}

export const LINT_RULE_IDS = [
  "uncached_prefix",
  "model_overspec",
  "missing_format_spec",
  "large_context_short_answer",
  "missing_system_prompt",
] as const;
export type LintRuleId = (typeof LINT_RULE_IDS)[number];

export interface Finding {
  rule: LintRuleId;
  model: string;
  requests7d: number;
  /** Monthly spend on the requests this finding is about. */
  monthlyAtStakeUsd: string;
  /** Monthly saving if fixed, where prices make it computable; otherwise null. */
  monthlySavingsUsd: string | null;
  detail: Record<string, string | number>;
  lastSeen: string;
}

/** Team-level findings: totals per rule, never per person. */
export interface RuleTotal {
  rule: LintRuleId;
  /** Null below the anonymity threshold, where a head count would point at someone. */
  people: number | null;
  monthlyAtStakeUsd: string;
  monthlySavingsUsd: string | null;
}

export interface ScoreView {
  asOfDay: string;
  windowDays: number;
  requests: number;
  score: string | null;
  components: {
    key: "retry" | "modelFit" | "cache" | "acceptance";
    /** The measured value, 0–1, or null when there was no input to measure. */
    value: string | null;
    /** Weight actually used after redistributing unmeasured components. */
    weight: string;
  }[];
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
    /** False for link-only accounts, which can set a first password without a current one. */
    hasPassword: boolean;
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
  /** One person's findings (self or consented drill-down); empty for team views. */
  findings: Finding[];
  /** Team view only: findings totalled per rule. */
  teamFindings: RuleTotal[];
  /** One person's latest efficiency score with its components; null for team views. */
  score: ScoreView | null;
}

export interface UsageError {
  error: { code: string; message: string };
}
