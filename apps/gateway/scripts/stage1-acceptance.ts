/**
 * Stage 1 acceptance: 20 real requests of varying length through the gateway.
 *
 * Checks that every request was metered exactly once and that TokenGrid's
 * stored cost equals the cost computed independently from the usage the SDK
 * received. The final comparison against the Anthropic console is manual,
 * because the console is not an API; the script prints the figure to compare.
 *
 *   TOKENGRID_KEY=tgk_... pnpm --filter @tokengrid/gateway acceptance:stage1
 *
 * Spends real money (roughly $0.25-$1 on the default model).
 */
import Anthropic from "@anthropic-ai/sdk";
import { and, eq, gte, sql as dsql } from "drizzle-orm";
import { CATALOG, createDb, hashVirtualKey, schema } from "@tokengrid/db";
import { computeCost, formatDecimal, parseDecimal, COST_SCALE, InvariantViolationError, type NormalizedUsage } from "@tokengrid/shared";

const key = process.env.TOKENGRID_KEY;
if (!key) {
  console.error("Set TOKENGRID_KEY to the virtual key printed by `pnpm db:seed`.");
  process.exit(1);
}
const model = process.env.ACCEPTANCE_MODEL ?? "claude-opus-5-5";
const gatewayUrl = process.env.GATEWAY_URL ?? `http://localhost:${process.env.GATEWAY_PORT ?? "8787"}`;
const price = CATALOG.find((p) => p.providerModelId === model && p.tier === "standard");
if (!price) {
  console.error(`No catalog price for ${model}; pick a model from packages/db/src/catalog.ts.`);
  process.exit(1);
}

const client = new Anthropic({ apiKey: key, baseURL: gatewayUrl });

const PARAGRAPH =
  "Substations meter every feeder on a shared scale so an operator can see at a glance which line is drawing load " +
  "and which is idling. The same panel shows faults, trips and overloads without needing a legend. ";
// Large enough to clear every current model's minimum cacheable prefix.
const CACHEABLE_SYSTEM = `You are a terse technical assistant.\n\n${PARAGRAPH.repeat(220)}`;

interface Case {
  stream: boolean;
  cached: boolean;
  prompt: string;
  maxTokens: number;
}

const cases: Case[] = Array.from({ length: 20 }, (_, i) => ({
  stream: i % 2 === 0,
  // Cases 14-19 share a cached system prefix: the first writes it, the rest
  // read it, exercising both cache rates.
  cached: i >= 14,
  prompt: `${PARAGRAPH.repeat(1 + ((i * 7) % 40))}\nIn ${1 + (i % 5)} sentence(s), summarise the text above. (case ${i})`,
  maxTokens: 512 + i * 128,
}));

function toUsage(u: Anthropic.Usage): NormalizedUsage {
  const created = u.cache_creation_input_tokens ?? 0;
  const oneHour = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  return {
    inputTokens: u.input_tokens,
    outputTokens: u.output_tokens,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
    cacheWrite5mTokens: created - oneHour,
    cacheWrite1hTokens: oneHour,
  };
}

const startedAt = new Date();
let expectedPico = 0n;
for (const [i, c] of cases.entries()) {
  const params: Anthropic.MessageCreateParamsNonStreaming = {
    model,
    max_tokens: c.maxTokens,
    output_config: { effort: "low" },
    ...(c.cached
      ? { system: [{ type: "text", text: CACHEABLE_SYSTEM, cache_control: { type: "ephemeral" } }] }
      : {}),
    messages: [{ role: "user", content: c.prompt }],
  };
  const message = c.stream ? await client.messages.stream(params).finalMessage() : await client.messages.create(params);
  const usage = toUsage(message.usage);
  expectedPico += computeCost(usage, price).totalPico;
  console.log(
    `#${String(i).padStart(2)} ${c.stream ? "stream" : "json  "} ${c.cached ? "cached" : "      "} ` +
      `in=${usage.inputTokens} out=${usage.outputTokens} cr=${usage.cacheReadTokens} cw=${usage.cacheWrite5mTokens + usage.cacheWrite1hTokens}`,
  );
}

const { db, sql } = createDb(undefined, { max: 1 });
try {
  const [vk] = await db
    .select({ id: schema.virtualKeys.id })
    .from(schema.virtualKeys)
    .where(eq(schema.virtualKeys.keyHash, hashVirtualKey(key)));
  if (!vk) throw new InvariantViolationError("virtual key accepted by the gateway is missing from Postgres");

  // Ingestion is asynchronous; give the worker a moment to drain the stream.
  let rows = { n: 0, cost: "0" };
  for (let attempt = 0; attempt < 30; attempt++) {
    const [r] = await db
      .select({ n: dsql<number>`count(*)::int`, cost: dsql<string>`coalesce(sum(${schema.usageEvents.costUsd}), 0)::text` })
      .from(schema.usageEvents)
      .where(and(eq(schema.usageEvents.virtualKeyId, vk.id), gte(schema.usageEvents.occurredAt, startedAt)));
    rows = r ?? rows;
    if (rows.n >= cases.length) break;
    await new Promise((r) => setTimeout(r, 1_000));
  }

  const [today] = await db
    .select({ cost: dsql<string>`coalesce(sum(${schema.usageEvents.costUsd}), 0)::text` })
    .from(schema.usageEvents)
    .where(gte(schema.usageEvents.occurredAt, dsql`date_trunc('day', now() at time zone 'utc') at time zone 'utc'`));

  const expected = formatDecimal(expectedPico, COST_SCALE);
  const countOk = rows.n === cases.length;
  const costOk = parseDecimal(rows.cost, COST_SCALE) === expectedPico;

  console.log("");
  console.log(`events stored:            ${rows.n} / ${cases.length} ${countOk ? "OK" : "MISMATCH"}`);
  console.log(`cost from SDK usage:      $${expected}`);
  console.log(`cost stored by TokenGrid: $${rows.cost} ${costOk ? "OK (exact)" : "MISMATCH"}`);
  console.log(`TokenGrid total today (UTC), all keys: $${today?.cost ?? "0"}`);
  console.log("Compare that last figure with the Anthropic console's cost for this workspace today (tolerance 1%).");
  if (!countOk || !costOk) process.exitCode = 1;
} finally {
  await sql.end();
}
