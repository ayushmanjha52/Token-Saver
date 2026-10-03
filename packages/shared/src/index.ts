export * from "./errors.js";
export * from "./usage.js";
export * from "./pricing.js";
export * from "./budget.js";
export * from "./prompt.js";
export * from "./login-link.js";

/** Redis Stream carrying usage events from gateways to the ingest worker. */
export const USAGE_STREAM = "tg:usage:v1";
export const USAGE_CONSUMER_GROUP = "ingest";

/** Redis cache entry for a resolved virtual key (see apps/gateway/src/auth.ts); deleted on revocation. */
export function virtualKeyCacheKey(keyHash: string): string {
  return `tg:vk:${keyHash}`;
}
