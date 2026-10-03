import { hostname } from "node:os";
import { Redis } from "ioredis";
import { createDb, ensureUsagePartitions } from "@tokengrid/db";
import { USAGE_CONSUMER_GROUP, USAGE_STREAM } from "@tokengrid/shared";
import { PriceCache } from "./prices.js";
import { processEntry } from "./process.js";
import { entriesFromRead, minStreamId, toEntries, type StreamEntry } from "./stream.js";

/** An entry unacked this long belongs to a consumer that crashed or hit a transient failure. */
const RECLAIM_IDLE_MS = 60_000;
/**
 * Acknowledged entries are kept this long before trimming, so a bad deploy
 * can be fixed and the window replayed (idempotency makes that safe).
 */
const RETAIN_MS = 24 * 60 * 60_000;
const BATCH = 100;

const log = {
  info: (obj: object, msg: string) => console.log(JSON.stringify({ level: "info", msg, ...obj })),
  warn: (obj: object, msg: string) =>
    console.warn(
      JSON.stringify({ level: "warn", msg, ...obj }, (_k, v: unknown) =>
        v instanceof Error ? { name: v.name, message: v.message } : v,
      ),
    ),
};

const redisUrl = process.env.REDIS_URL;
if (!redisUrl) {
  console.error("REDIS_URL is required. See .env.example.");
  process.exit(1);
}
const redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
const { db, sql } = createDb(undefined, { max: 4 });
const prices = new PriceCache(db);
const consumer = `${hostname()}-${process.pid}`;
let stopping = false;

async function ensureGroup(): Promise<void> {
  try {
    // Start at 0, not $: events the gateway wrote before the first worker
    // ever started must still be consumed.
    await redis.xgroup("CREATE", USAGE_STREAM, USAGE_CONSUMER_GROUP, "0", "MKSTREAM");
  } catch (err) {
    if (!(err instanceof Error && err.message.includes("BUSYGROUP"))) throw err;
  }
}

async function handle(entries: StreamEntry[], deliveries: (id: string) => number): Promise<void> {
  for (const e of entries) {
    const outcome = await processEntry(db, prices, e.id, e.payload, deliveries(e.id), log);
    // XACK only after the outcome is durable in Postgres; acking first would
    // lose the event if the process died before the insert committed.
    if (outcome !== "retry") await redis.xack(USAGE_STREAM, USAGE_CONSUMER_GROUP, e.id);
  }
}

async function reclaimStale(): Promise<void> {
  const pending = (await redis.xpending(
    USAGE_STREAM,
    USAGE_CONSUMER_GROUP,
    "IDLE",
    RECLAIM_IDLE_MS,
    "-",
    "+",
    BATCH,
  )) as unknown[];
  if (pending.length === 0) return;
  const counts = new Map<string, number>();
  for (const p of pending) {
    if (Array.isArray(p) && typeof p[0] === "string" && typeof p[3] === "number") counts.set(p[0], p[3]);
  }
  const ids = [...counts.keys()];
  if (ids.length === 0) return;
  const claimed = toEntries(
    await redis.xclaim(USAGE_STREAM, USAGE_CONSUMER_GROUP, consumer, RECLAIM_IDLE_MS, ...ids),
  );
  // XCLAIM itself counts as a delivery.
  await handle(claimed, (id) => (counts.get(id) ?? 0) + 1);
}

async function trimAcknowledged(): Promise<void> {
  let floor = `${Date.now() - RETAIN_MS}-0`;
  const groups = (await redis.xinfo("GROUPS", USAGE_STREAM)) as unknown[];
  for (const g of groups) {
    if (!Array.isArray(g)) continue;
    const info = new Map<string, unknown>();
    for (let i = 0; i + 1 < g.length; i += 2) info.set(String(g[i]), g[i + 1]);
    const name = info.get("name");
    const lastDelivered = info.get("last-delivered-id");
    if (typeof lastDelivered === "string") floor = minStreamId(floor, lastDelivered);
    if (typeof name === "string") {
      const summary = (await redis.xpending(USAGE_STREAM, name)) as unknown[];
      if (typeof summary[1] === "string") floor = minStreamId(floor, summary[1]);
    }
  }
  // Never trims past any group's oldest pending or undelivered entry.
  await redis.xtrim(USAGE_STREAM, "MINID", "~", floor);
}

function every(ms: number, name: string, fn: () => Promise<void>): NodeJS.Timeout {
  const t = setInterval(() => {
    fn().catch((err: unknown) => log.warn({ err }, `${name} failed`));
  }, ms);
  t.unref();
  return t;
}

async function main(): Promise<void> {
  await ensureGroup();
  await ensureUsagePartitions(db);
  await prices.load();
  log.info({ consumer, stream: USAGE_STREAM }, "ingest worker started");

  every(6 * 60 * 60_000, "partition maintenance", () => ensureUsagePartitions(db));
  every(10 * 60_000, "stream trim", trimAcknowledged);

  let lastReclaim = 0;
  while (!stopping) {
    try {
      if (Date.now() - lastReclaim > RECLAIM_IDLE_MS / 2) {
        lastReclaim = Date.now();
        await reclaimStale();
      }
      const read = await redis.xreadgroup(
        "GROUP",
        USAGE_CONSUMER_GROUP,
        consumer,
        "COUNT",
        BATCH,
        "BLOCK",
        5_000,
        "STREAMS",
        USAGE_STREAM,
        ">",
      );
      await handle(entriesFromRead(read), () => 1);
    } catch (err) {
      log.warn({ err }, "worker loop error; backing off");
      await new Promise((r) => setTimeout(r, 1_000));
    }
  }
}

async function shutdown(): Promise<void> {
  stopping = true;
  // Unacked entries stay pending and are reclaimed by the next worker.
  await Promise.allSettled([redis.quit(), sql.end({ timeout: 5 })]);
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());

await main();
