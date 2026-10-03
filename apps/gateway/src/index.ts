import { Redis } from "ioredis";
import { Agent } from "undici";
import { createDb } from "@tokengrid/db";
import { VirtualKeyResolver } from "./auth.js";
import { AnthropicAdapter } from "./providers/anthropic.js";
import { OpenAIAdapter } from "./providers/openai.js";
import { BudgetGuard } from "./budget.js";
import { loadConfig } from "./config.js";
import { UsageEmitter } from "./emit.js";
import { createApp, registerRoutes } from "./server.js";

const config = loadConfig();
const app = createApp();

const redis = new Redis(config.redisUrl, {
  // Fail fast instead of queueing: a command queued behind a dead connection
  // would hold the user's request (key lookup) or grow memory (emit) without
  // bound. Both callers have their own fallback.
  enableOfflineQueue: false,
  maxRetriesPerRequest: 1,
  commandTimeout: 250,
});
redis.on("error", () => {
  // ioredis reconnects on its own; logging every attempt would flood the log during an outage.
});

const { db, sql } = createDb(config.databaseUrl, { max: 5 });

const dispatcher = new Agent({
  // Non-streaming requests to large models can think for many minutes before
  // the first header byte; undici's 300s default would fail them.
  headersTimeout: 15 * 60_000,
  // Anthropic sends SSE pings, so a long silent gap means a dead connection.
  bodyTimeout: 5 * 60_000,
  connections: 512,
});

const emitter = new UsageEmitter(redis, app.log);
registerRoutes(app, {
  resolver: new VirtualKeyResolver(redis, db, app.log),
  emitter,
  budgets: new BudgetGuard(redis, app.log),
  dispatcher,
  adapters: [new AnthropicAdapter(config.anthropicUpstreamUrl), new OpenAIAdapter(config.openaiUpstreamUrl)],
});

async function shutdown(signal: string) {
  app.log.info({ signal }, "shutting down");
  // Stop accepting, let in-flight streams finish, then give buffered events a last chance.
  await app.close();
  await emitter.close();
  await Promise.allSettled([redis.quit(), sql.end(), dispatcher.close()]);
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await app.listen({ port: config.port, host: config.host });
