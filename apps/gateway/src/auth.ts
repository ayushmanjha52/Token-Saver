import { and, eq, isNull } from "drizzle-orm";
import type { Redis } from "ioredis";
import { decryptSecret, hashVirtualKey, isVirtualKeyShape, schema, type Database } from "@tokengrid/db";
import { PROVIDERS, type Provider } from "@tokengrid/shared";

function isProvider(p: string): p is Provider {
  return (PROVIDERS as readonly string[]).includes(p);
}

export class AuthBackendUnavailableError extends Error {
  override readonly name = "AuthBackendUnavailableError";
  constructor(cause: unknown) {
    super("Neither Redis nor Postgres could resolve the virtual key", { cause });
  }
}

export interface ResolvedKey {
  virtualKeyId: string;
  orgId: string;
  userId: string;
  /** Decrypted upstream keys by provider; held in process memory only. */
  upstreamKeys: Partial<Record<Provider, string>>;
}

/** What is cached in Redis: ciphertext only, so a Redis dump leaks no upstream keys. */
interface CachedRecord {
  virtualKeyId: string;
  orgId: string;
  userId: string;
  credentials: Partial<Record<Provider, string>>;
}

interface MemoryEntry {
  value: ResolvedKey | null;
  expiresAt: number;
}

/**
 * Two cache tiers in front of Postgres. Revocation therefore takes up to
 * MEMORY_TTL + REDIS_TTL to bite unless the revoking code also deletes the
 * Redis entry; that is the price of keeping Postgres off the request path.
 */
const MEMORY_TTL_MS = 60_000;
const NEGATIVE_TTL_MS = 30_000;
const REDIS_TTL_S = 300;
const MEMORY_MAX = 10_000;

export function redisKeyFor(hash: string): string {
  return `tg:vk:${hash}`;
}

export class VirtualKeyResolver {
  private readonly memory = new Map<string, MemoryEntry>();

  constructor(
    private readonly redis: Redis,
    private readonly db: Database,
    private readonly log: { warn: (obj: object, msg: string) => void },
  ) {}

  async resolve(presented: string): Promise<ResolvedKey | null> {
    if (!isVirtualKeyShape(presented)) return null;
    const hash = hashVirtualKey(presented);
    const now = Date.now();
    const hit = this.memory.get(hash);
    if (hit && hit.expiresAt > now) return hit.value;

    const record = await this.lookup(hash);
    const value = record ? this.decrypt(record) : null;
    this.remember(hash, value, now + (value ? MEMORY_TTL_MS : NEGATIVE_TTL_MS));
    return value;
  }

  private async lookup(hash: string): Promise<CachedRecord | null> {
    let redisDown = false;
    try {
      const cached = await this.redis.get(redisKeyFor(hash));
      if (cached === "null") return null;
      if (cached) return JSON.parse(cached) as CachedRecord;
    } catch (err) {
      redisDown = true;
      this.log.warn({ err }, "redis unavailable for key lookup; falling back to postgres");
    }

    let record: CachedRecord | null;
    try {
      record = await this.fromPostgres(hash);
    } catch (err) {
      throw new AuthBackendUnavailableError(err);
    }
    if (!redisDown) {
      this.redis
        .set(redisKeyFor(hash), JSON.stringify(record), "EX", record ? REDIS_TTL_S : NEGATIVE_TTL_MS / 1000)
        .catch((err: unknown) => this.log.warn({ err }, "failed to populate key cache"));
    }
    return record;
  }

  private async fromPostgres(hash: string): Promise<CachedRecord | null> {
    const { virtualKeys, providerCredentials } = schema;
    const rows = await this.db
      .select({
        virtualKeyId: virtualKeys.id,
        orgId: virtualKeys.orgId,
        userId: virtualKeys.userId,
        provider: providerCredentials.provider,
        ciphertext: providerCredentials.ciphertext,
      })
      .from(virtualKeys)
      .leftJoin(
        providerCredentials,
        and(eq(providerCredentials.orgId, virtualKeys.orgId), isNull(providerCredentials.revokedAt)),
      )
      .where(and(eq(virtualKeys.keyHash, hash), isNull(virtualKeys.revokedAt)));
    const first = rows[0];
    if (!first) return null;
    const credentials: Partial<Record<Provider, string>> = {};
    for (const r of rows) {
      if (r.provider && r.ciphertext && isProvider(r.provider)) credentials[r.provider] = r.ciphertext;
    }
    return { virtualKeyId: first.virtualKeyId, orgId: first.orgId, userId: first.userId, credentials };
  }

  private decrypt(record: CachedRecord): ResolvedKey {
    const upstreamKeys: Partial<Record<Provider, string>> = {};
    for (const [provider, ciphertext] of Object.entries(record.credentials) as [Provider, string][]) {
      upstreamKeys[provider] = decryptSecret(ciphertext, { orgId: record.orgId, provider });
    }
    return { virtualKeyId: record.virtualKeyId, orgId: record.orgId, userId: record.userId, upstreamKeys };
  }

  private remember(hash: string, value: ResolvedKey | null, expiresAt: number): void {
    // Map preserves insertion order, so the first key is the oldest; a full
    // LRU buys little when entries expire within a minute anyway.
    if (this.memory.size >= MEMORY_MAX) {
      const oldest = this.memory.keys().next();
      if (!oldest.done) this.memory.delete(oldest.value);
    }
    this.memory.set(hash, { value, expiresAt });
  }
}
