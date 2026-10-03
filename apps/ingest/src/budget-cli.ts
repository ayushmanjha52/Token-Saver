/**
 * Sets or removes a monthly budget, then pushes budgets to Redis immediately
 * instead of waiting for the worker's next sync.
 *
 *   pnpm --filter @tokengrid/ingest budget set   --scope user --email a@tokengrid.local --limit 1.00
 *   pnpm --filter @tokengrid/ingest budget set   --scope org  --email a@tokengrid.local --limit 500
 *   pnpm --filter @tokengrid/ingest budget set   --scope key  --key-prefix tgk_AbCdEfGh --limit 5
 *   pnpm --filter @tokengrid/ingest budget clear --scope user --email a@tokengrid.local
 */
import { parseArgs } from "node:util";
import { and, eq } from "drizzle-orm";
import { Redis } from "ioredis";
import { createDb, schema } from "@tokengrid/db";
import { BUDGET_SCOPES, usdToNano, type BudgetScope } from "@tokengrid/shared";
import { SpendCounters } from "./spend.js";

export class BudgetCliError extends Error {
  override readonly name = "BudgetCliError";
}

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    scope: { type: "string" },
    email: { type: "string" },
    "key-prefix": { type: "string" },
    limit: { type: "string" },
  },
});
const action = positionals[0];
const scope = values.scope as BudgetScope | undefined;
if ((action !== "set" && action !== "clear") || !scope || !(BUDGET_SCOPES as readonly string[]).includes(scope)) {
  throw new BudgetCliError("usage: budget <set|clear> --scope <key|user|org> (--email <email> | --key-prefix <prefix>) [--limit <usd>]");
}

const { db, sql } = createDb(undefined, { max: 1 });
try {
  let orgId: string;
  let scopeId: string;
  if (scope === "key") {
    const prefix = values["key-prefix"];
    if (!prefix) throw new BudgetCliError("--key-prefix is required for --scope key");
    const keys = await db
      .select({ id: schema.virtualKeys.id, orgId: schema.virtualKeys.orgId })
      .from(schema.virtualKeys)
      .where(eq(schema.virtualKeys.keyPrefix, prefix.slice(0, 12)));
    const [k] = keys;
    if (!k || keys.length > 1) throw new BudgetCliError(`expected exactly one key with prefix ${prefix}, found ${keys.length}`);
    orgId = k.orgId;
    scopeId = k.id;
  } else {
    const email = values.email;
    if (!email) throw new BudgetCliError("--email is required for --scope user|org");
    const users = await db.select({ id: schema.users.id, orgId: schema.users.orgId }).from(schema.users).where(eq(schema.users.email, email));
    const [u] = users;
    if (!u || users.length > 1) throw new BudgetCliError(`expected exactly one user with email ${email}, found ${users.length}`);
    orgId = u.orgId;
    scopeId = scope === "org" ? u.orgId : u.id;
  }

  if (action === "set") {
    const limit = values.limit;
    if (!limit) throw new BudgetCliError("--limit is required for set");
    usdToNano(limit);
    await db
      .insert(schema.budgets)
      .values({ orgId, scope, scopeId, limitUsd: limit })
      .onConflictDoUpdate({
        target: [schema.budgets.scope, schema.budgets.scopeId],
        set: { limitUsd: limit, updatedAt: new Date() },
      });
  } else {
    await db.delete(schema.budgets).where(and(eq(schema.budgets.scope, scope), eq(schema.budgets.scopeId, scopeId)));
  }

  const redisUrl = process.env.REDIS_URL;
  if (redisUrl) {
    const redis = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
    try {
      await new SpendCounters(redis).syncBudgets(db);
      console.log(`budget ${action === "set" ? `set to $${values.limit}` : "cleared"} for ${scope} ${scopeId}; live in Redis now`);
    } finally {
      redis.disconnect();
    }
  } else {
    console.log(`budget ${action} for ${scope} ${scopeId}; REDIS_URL unset, the worker will publish it within 30s`);
  }
} finally {
  await sql.end();
}
