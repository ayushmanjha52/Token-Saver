import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
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
  createdAt: timestamptz("created_at").notNull().defaultNow(),
});

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id),
    email: text("email").notNull(),
    displayName: text("display_name").notNull(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("users_org_email_uq").on(t.orgId, t.email)],
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
    ciphertext: text("ciphertext").notNull(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    revokedAt: timestamptz("revoked_at"),
  },
  (t) => [
    uniqueIndex("provider_credentials_live_uq")
      .on(t.orgId, t.provider)
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
