import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

// Every timestamp is timestamptz: a naive timestamp read on a host with a
// different TZ shifts events across day and month (partition) boundaries.
const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const organizations = pgTable("organizations", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  /**
   * How long per-person usage detail is kept. 395 days covers a full
   * year-on-year comparison; anything longer is monitoring data kept
   * without a purpose.
   */
  retentionDays: integer("retention_days").notNull().default(395),
  createdAt: timestamptz("created_at").notNull().defaultNow(),
});

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id),
    email: text("email").notNull(),
    displayName: text("display_name").notNull(),
    /** 'member' | 'admin'. Admins see every team's aggregates; individual data still needs consent. */
    orgRole: text("org_role").notNull().default("member"),
    /** scrypt hash; null for people who only ever sign in with one-time links. */
    passwordHash: text("password_hash"),
    /** Consecutive failed password sign-ins; reset on success. */
    failedLogins: integer("failed_logins").notNull().default(0),
    /** Password sign-in is refused until this time after too many failures. */
    lockedUntil: timestamptz("locked_until"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("users_org_email_uq").on(t.orgId, t.email),
    // Password sign-in looks people up by email alone, so an email can hold a
    // password in at most one org.
    uniqueIndex("users_password_email_uq")
      .on(sql`lower(${t.email})`)
      .where(sql`${t.passwordHash} is not null`),
  ],
);

/**
 * Fixed-window counters for sign-up and sign-in attempts, keyed by a hash of
 * the client address. Kept in Postgres because the dashboard runs as
 * serverless functions that share no memory between requests.
 */
export const authThrottle = pgTable("auth_throttle", {
  key: text("key").primaryKey(),
  windowStart: timestamptz("window_start").notNull(),
  attempts: integer("attempts").notNull(),
});

export const teams = pgTable(
  "teams",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id),
    name: text("name").notNull(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("teams_org_name_uq").on(t.orgId, t.name)],
);

/** Team membership. role is 'member' | 'manager'; a manager sees the team's aggregates. */
export const memberships = pgTable(
  "memberships",
  {
    teamId: uuid("team_id").notNull().references(() => teams.id),
    userId: uuid("user_id").notNull().references(() => users.id),
    role: text("role").notNull(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.teamId, t.userId] }), index("memberships_user_idx").on(t.userId)],
);

/**
 * A person's permission for their managers to see their individual usage.
 * Rows are never updated except to set revoked_at, so the history of who
 * allowed what, when, survives for the audit trail.
 */
export const drilldownConsents = pgTable(
  "drilldown_consents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id),
    subjectUserId: uuid("subject_user_id").notNull().references(() => users.id),
    grantedAt: timestamptz("granted_at").notNull().defaultNow(),
    revokedAt: timestamptz("revoked_at"),
  },
  (t) => [
    uniqueIndex("drilldown_consents_active_uq")
      .on(t.subjectUserId)
      .where(sql`${t.revokedAt} is null`),
  ],
);

/** Every read of one person's data by someone else. Written before the data is returned. */
export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id),
    actorUserId: uuid("actor_user_id").notNull().references(() => users.id),
    subjectUserId: uuid("subject_user_id").references(() => users.id),
    action: text("action").notNull(),
    detail: jsonb("detail").notNull(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("audit_log_org_time_idx").on(t.orgId, t.createdAt),
    index("audit_log_subject_idx").on(t.subjectUserId, t.createdAt),
  ],
);

/** Monthly (UTC calendar month) spend limits. Scope is 'key' | 'user' | 'org'. */
export const budgets = pgTable(
  "budgets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id),
    scope: text("scope").notNull(),
    scopeId: uuid("scope_id").notNull(),
    limitUsd: numeric("limit_usd", { precision: 14, scale: 2 }).notNull(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("budgets_scope_uq").on(t.scope, t.scopeId)],
);

/**
 * The org's real upstream key, envelope-encrypted (see crypto.ts). At most
 * one live credential per org and provider so the gateway never has to
 * choose between two.
 */
export const providerCredentials = pgTable(
  "provider_credentials",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id),
    provider: text("provider").notNull(),
    /**
     * 'api' keys are what the gateway forwards with; 'admin' keys only read
     * the provider's usage and cost reports for reconciliation, and the
     * gateway never loads them.
     */
    kind: text("kind").notNull().default("api"),
    /**
     * Admin keys only: the provider workspace or project the gateway's API
     * key belongs to. Reconciliation compares against that scope alone, so
     * traffic that never passed through TokenGrid does not read as drift.
     */
    reconcileScope: text("reconcile_scope"),
    ciphertext: text("ciphertext").notNull(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    revokedAt: timestamptz("revoked_at"),
  },
  (t) => [
    uniqueIndex("provider_credentials_live_uq")
      .on(t.orgId, t.provider, t.kind)
      .where(sql`${t.revokedAt} is null`),
  ],
);

/**
 * TokenGrid-issued keys. Only a SHA-256 of the key is stored: the keys carry
 * 256 bits of entropy, so a slow KDF would add request latency without adding
 * resistance to guessing.
 */
export const virtualKeys = pgTable(
  "virtual_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id),
    userId: uuid("user_id").notNull().references(() => users.id),
    name: text("name").notNull(),
    /** First characters of the key, so a person can tell their keys apart without us storing the key. */
    keyPrefix: text("key_prefix").notNull(),
    keyHash: text("key_hash").notNull(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    revokedAt: timestamptz("revoked_at"),
  },
  (t) => [uniqueIndex("virtual_keys_hash_uq").on(t.keyHash)],
);

export const models = pgTable(
  "models",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    provider: text("provider").notNull(),
    /** Exactly the string the provider returns in its response `model` field. */
    providerModelId: text("provider_model_id").notNull(),
    /**
     * 'frontier' | 'balanced' | 'fast'. The model-fit lint compares a
     * request against the cheapest current model one tier down, so the tier
     * is data, not a pattern match on model names.
     */
    tier: text("tier").notNull().default("balanced"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("models_provider_model_uq").on(t.provider, t.providerModelId)],
);

/**
 * Append-only price history. A price change is a new row with a new
 * `effective_from`; editing a row in place would silently re-price every
 * historical event that already carries its id.
 */
export const modelPrices = pgTable(
  "model_prices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    modelId: uuid("model_id").notNull().references(() => models.id),
    tier: text("tier").notNull(),
    effectiveFrom: timestamptz("effective_from").notNull(),
    effectiveTo: timestamptz("effective_to"),
    inputPerMtok: numeric("input_per_mtok", { precision: 14, scale: 6 }).notNull(),
    outputPerMtok: numeric("output_per_mtok", { precision: 14, scale: 6 }).notNull(),
    cacheReadPerMtok: numeric("cache_read_per_mtok", { precision: 14, scale: 6 }).notNull(),
    cacheWrite5mPerMtok: numeric("cache_write_5m_per_mtok", { precision: 14, scale: 6 }).notNull(),
    cacheWrite1hPerMtok: numeric("cache_write_1h_per_mtok", { precision: 14, scale: 6 }).notNull(),
    /** Where the figures were transcribed from, so a wrong price can be traced to its origin. */
    source: text("source").notNull(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("model_prices_version_uq").on(t.modelId, t.tier, t.effectiveFrom)],
);

/**
 * Global idempotency ledger. Postgres requires every unique index on a
 * partitioned table to include the partition key, so `usage_events` alone can
 * only enforce uniqueness per (request id, timestamp). A replay that carries a
 * different timestamp (reconciliation backfill, a re-emitted event) would slip
 * through; this unpartitioned table closes that hole.
 */
export const usageEventIds = pgTable(
  "usage_event_ids",
  {
    provider: text("provider").notNull(),
    providerRequestId: text("provider_request_id").notNull(),
    occurredAt: timestamptz("occurred_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.provider, t.providerRequestId] })],
);

/**
 * Raw events, partitioned by month on `occurred_at`. The migration rewrites
 * the generated CREATE TABLE to add `PARTITION BY RANGE`; drizzle-kit does
 * not model partitioning, and does not diff it either, so later column
 * changes still generate correct ALTERs.
 */
export const usageEvents = pgTable(
  "usage_events",
  {
    id: uuid("id").notNull().defaultRandom(),
    occurredAt: timestamptz("occurred_at").notNull(),
    provider: text("provider").notNull(),
    providerRequestId: text("provider_request_id").notNull(),
    orgId: uuid("org_id").notNull().references(() => organizations.id),
    userId: uuid("user_id").notNull().references(() => users.id),
    virtualKeyId: uuid("virtual_key_id").notNull().references(() => virtualKeys.id),
    model: text("model").notNull(),
    pricingTier: text("pricing_tier").notNull(),
    priceId: uuid("price_id").notNull().references(() => modelPrices.id),
    inputTokens: integer("input_tokens").notNull(),
    outputTokens: integer("output_tokens").notNull(),
    cacheReadTokens: integer("cache_read_tokens").notNull(),
    cacheWrite5mTokens: integer("cache_write_5m_tokens").notNull(),
    cacheWrite1hTokens: integer("cache_write_1h_tokens").notNull(),
    /** Exact to the pico-dollar; see computeCost. */
    costUsd: numeric("cost_usd", { precision: 24, scale: 12 }).notNull(),
    durationMs: integer("duration_ms").notNull(),
    httpStatus: smallint("http_status").notNull(),
    streamed: boolean("streamed").notNull(),
    usageComplete: boolean("usage_complete").notNull(),
    stopReason: text("stop_reason"),
    ingestedAt: timestamptz("ingested_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.id, t.occurredAt] }),
    uniqueIndex("usage_events_request_uq").on(t.provider, t.providerRequestId, t.occurredAt),
    index("usage_events_org_time_idx").on(t.orgId, t.occurredAt),
    index("usage_events_user_time_idx").on(t.userId, t.occurredAt),
  ],
);

/**
 * Hourly aggregates, maintained by the worker in the same transaction as the
 * raw insert, so a rollup can never disagree with the events it summarises.
 * Every dashboard aggregate reads from here; raw events are for drill-down.
 */
export const usageRollupHourly = pgTable(
  "usage_rollup_hourly",
  {
    bucketStart: timestamptz("bucket_start").notNull(),
    orgId: uuid("org_id").notNull().references(() => organizations.id),
    userId: uuid("user_id").notNull().references(() => users.id),
    virtualKeyId: uuid("virtual_key_id").notNull().references(() => virtualKeys.id),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    requests: integer("requests").notNull(),
    /** Requests whose stream ended before final usage arrived; their output counts are floors. */
    incompleteRequests: integer("incomplete_requests").notNull(),
    inputTokens: bigint("input_tokens", { mode: "bigint" }).notNull(),
    outputTokens: bigint("output_tokens", { mode: "bigint" }).notNull(),
    cacheReadTokens: bigint("cache_read_tokens", { mode: "bigint" }).notNull(),
    cacheWriteTokens: bigint("cache_write_tokens", { mode: "bigint" }).notNull(),
    costUsd: numeric("cost_usd", { precision: 24, scale: 12 }).notNull(),
    /** Requests in this bucket that were later re-sent, i.e. whose response was discarded. */
    retriedRequests: integer("retried_requests").notNull().default(0),
    /** Cost of those discarded responses, charged to the hour the discarded request ran, not the hour of the retry. */
    wastedCostUsd: numeric("wasted_cost_usd", { precision: 24, scale: 12 }).notNull().default("0"),
  },
  (t) => [
    primaryKey({ columns: [t.bucketStart, t.orgId, t.userId, t.virtualKeyId, t.provider, t.model] }),
    index("usage_rollup_org_time_idx").on(t.orgId, t.bucketStart),
  ],
);

/**
 * Events the worker could not price or parse. Kept as the original payload so
 * a redrive after the fix (e.g. adding a missing price row) is lossless.
 */
export const usageDlq = pgTable(
  "usage_dlq",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    streamEntryId: text("stream_entry_id").notNull(),
    payload: text("payload").notNull(),
    errorName: text("error_name").notNull(),
    errorMessage: text("error_message").notNull(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    resolvedAt: timestamptz("resolved_at"),
  },
  (t) => [uniqueIndex("usage_dlq_entry_uq").on(t.streamEntryId)],
);

/**
 * Per-request prompt features from the gateway: hashes and sizes, never
 * text. Retry detection looks back 15 minutes and lint looks back 7 days, so
 * rows are pruned after PROMPT_FEATURE_RETENTION_DAYS.
 */
export const promptFeatures = pgTable(
  "prompt_features",
  {
    provider: text("provider").notNull(),
    providerRequestId: text("provider_request_id").notNull(),
    occurredAt: timestamptz("occurred_at").notNull(),
    orgId: uuid("org_id").notNull().references(() => organizations.id),
    userId: uuid("user_id").notNull().references(() => users.id),
    virtualKeyId: uuid("virtual_key_id").notNull().references(() => virtualKeys.id),
    sessionKey: text("session_key").notNull(),
    model: text("model").notNull(),
    fingerprint: text("fingerprint").notNull(),
    lastUserSimhash: text("last_user_simhash").notNull(),
    lastUserChars: integer("last_user_chars").notNull(),
    lastUserNumbers: text("last_user_numbers").notNull(),
    messageCount: integer("message_count").notNull(),
    prefixHash: text("prefix_hash"),
    /** Prompt tokens before the final user turn: measured prompt tokens scaled by the prefix share of characters. */
    prefixTokensEst: integer("prefix_tokens_est").notNull(),
    hasSystem: boolean("has_system").notNull(),
    hasFormatSpec: boolean("has_format_spec").notNull(),
    usesCacheControl: boolean("uses_cache_control").notNull(),
    inputTokens: integer("input_tokens").notNull(),
    outputTokens: integer("output_tokens").notNull(),
    cacheReadTokens: integer("cache_read_tokens").notNull(),
    cacheWriteTokens: integer("cache_write_tokens").notNull(),
    costUsd: numeric("cost_usd", { precision: 24, scale: 12 }).notNull(),
    /** Lint rules that matched this request. */
    flags: text("flags").array().notNull().default(sql`'{}'::text[]`),
  },
  (t) => [
    primaryKey({ columns: [t.provider, t.providerRequestId] }),
    index("prompt_features_session_idx").on(t.sessionKey, t.occurredAt),
    index("prompt_features_user_fp_idx").on(t.userId, t.fingerprint, t.occurredAt),
    index("prompt_features_user_prefix_idx").on(t.userId, t.prefixHash, t.occurredAt),
    index("prompt_features_user_time_idx").on(t.userId, t.occurredAt),
  ],
);

/** A request whose response was thrown away because the same prompt was re-sent. One row per discarded request. */
export const retries = pgTable(
  "retries",
  {
    provider: text("provider").notNull(),
    discardedRequestId: text("discarded_request_id").notNull(),
    retryRequestId: text("retry_request_id").notNull(),
    orgId: uuid("org_id").notNull().references(() => organizations.id),
    userId: uuid("user_id").notNull().references(() => users.id),
    discardedAt: timestamptz("discarded_at").notNull(),
    wastedCostUsd: numeric("wasted_cost_usd", { precision: 24, scale: 12 }).notNull(),
    wastedTokens: bigint("wasted_tokens", { mode: "number" }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.provider, t.discardedRequestId] }),
    index("retries_user_time_idx").on(t.userId, t.discardedAt),
  ],
);

/**
 * Current prompt-lint findings, one row per person, rule and prompt group.
 * Figures are monthly, extrapolated from the trailing 7 days. Every finding
 * states the spend it affects; savings are filled only where prices make
 * them computable.
 */
export const lintFindings = pgTable(
  "lint_findings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id),
    userId: uuid("user_id").notNull().references(() => users.id),
    rule: text("rule").notNull(),
    /** The prompt fingerprint or prefix hash the finding is about. */
    groupKey: text("group_key").notNull(),
    model: text("model").notNull(),
    requests7d: integer("requests_7d").notNull(),
    monthlyAtStakeUsd: numeric("monthly_at_stake_usd", { precision: 14, scale: 4 }).notNull(),
    monthlySavingsUsd: numeric("monthly_savings_usd", { precision: 14, scale: 4 }),
    detail: jsonb("detail").notNull(),
    firstSeen: timestamptz("first_seen").notNull(),
    lastSeen: timestamptz("last_seen").notNull(),
  },
  (t) => [uniqueIndex("lint_findings_uq").on(t.userId, t.rule, t.groupKey)],
);

/**
 * Efficiency score per person per day over a trailing window. Every
 * component and the weight it actually carried are stored, so a score is
 * always shown with what produced it. A null component had no measured input
 * and its weight went to the others.
 */
export const efficiencyScores = pgTable(
  "efficiency_scores",
  {
    userId: uuid("user_id").notNull().references(() => users.id),
    orgId: uuid("org_id").notNull().references(() => organizations.id),
    asOfDay: date("as_of_day", { mode: "string" }).notNull(),
    windowDays: integer("window_days").notNull(),
    requests: integer("requests").notNull(),
    retryRate: numeric("retry_rate", { precision: 6, scale: 5 }),
    modelFit: numeric("model_fit", { precision: 6, scale: 5 }),
    cacheHitRate: numeric("cache_hit_rate", { precision: 6, scale: 5 }),
    acceptanceRate: numeric("acceptance_rate", { precision: 6, scale: 5 }),
    weightRetry: numeric("weight_retry", { precision: 4, scale: 3 }).notNull(),
    weightModelFit: numeric("weight_model_fit", { precision: 4, scale: 3 }).notNull(),
    weightCache: numeric("weight_cache", { precision: 4, scale: 3 }).notNull(),
    weightAcceptance: numeric("weight_acceptance", { precision: 4, scale: 3 }).notNull(),
    score: numeric("score", { precision: 5, scale: 2 }),
    computedAt: timestamptz("computed_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.asOfDay] })],
);

/**
 * One row per org, provider, UTC day and model: what the provider billed
 * against what TokenGrid metered. Kept as rows so drift is a chart over
 * time, not a log line.
 */
export const reconciliations = pgTable(
  "reconciliations",
  {
    orgId: uuid("org_id").notNull().references(() => organizations.id),
    provider: text("provider").notNull(),
    day: date("day", { mode: "string" }).notNull(),
    model: text("model").notNull(),
    providerUsd: numeric("provider_usd", { precision: 16, scale: 6 }).notNull(),
    meteredUsd: numeric("metered_usd", { precision: 16, scale: 6 }).notNull(),
    /** (metered - provider) / provider. Null when the provider billed nothing. */
    driftRatio: numeric("drift_ratio", { precision: 10, scale: 6 }),
    /** 'ok' | 'drift' */
    status: text("status").notNull(),
    checkedAt: timestamptz("checked_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.provider, t.day, t.model] })],
);

/** Operational alerts for org admins. Delivered to ALERT_WEBHOOK_URL when set; always stored. */
export const alerts = pgTable(
  "alerts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id),
    kind: text("kind").notNull(),
    /** Deduplicates re-runs: the same drift on the same day raises one alert. */
    dedupeKey: text("dedupe_key").notNull(),
    message: text("message").notNull(),
    detail: jsonb("detail").notNull(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    acknowledgedAt: timestamptz("acknowledged_at"),
  },
  (t) => [uniqueIndex("alerts_dedupe_uq").on(t.orgId, t.dedupeKey), index("alerts_org_time_idx").on(t.orgId, t.createdAt)],
);

/**
 * One-time sign-in links issued by an operator (admin CLI) until an
 * identity provider is wired in. The link itself is HMAC-signed; this row
 * is what makes it single-use.
 */
export const loginLinks = pgTable("login_links", {
  nonce: text("nonce").primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id),
  expiresAt: timestamptz("expires_at").notNull(),
  usedAt: timestamptz("used_at"),
  createdAt: timestamptz("created_at").notNull().defaultNow(),
});
