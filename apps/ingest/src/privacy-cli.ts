/**
 * Data-subject operations for operators handling a request outside the dashboard.
 *
 *   pnpm --filter @tokengrid/ingest privacy export --email a@tokengrid.local > a.ndjson
 *   pnpm --filter @tokengrid/ingest privacy delete --email a@tokengrid.local --by admin@tokengrid.local --confirm
 *   pnpm --filter @tokengrid/ingest privacy retention
 */
import { parseArgs } from "node:util";
import { eq } from "drizzle-orm";
import { applyRetention, createDb, deleteUserData, exportUserData, schema } from "@tokengrid/db";

export class PrivacyCliError extends Error {
  override readonly name = "PrivacyCliError";
}

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { email: { type: "string" }, by: { type: "string" }, confirm: { type: "boolean" } },
});
const action = positionals[0];

const { db, sql } = createDb(undefined, { max: 1 });
const userId = async (email: string | undefined, flag: string) => {
  if (!email) throw new PrivacyCliError(`--${flag} is required`);
  const [u] = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, email));
  if (!u) throw new PrivacyCliError(`no user with email ${email}`);
  return u.id;
};

try {
  if (action === "export") {
    for await (const record of exportUserData(db, await userId(values.email, "email"))) process.stdout.write(`${JSON.stringify(record)}\n`);
  } else if (action === "delete") {
    if (!values.confirm) throw new PrivacyCliError("deletion is irreversible; pass --confirm");
    const counts = await deleteUserData(db, await userId(values.email, "email"), await userId(values.by, "by"));
    console.log(JSON.stringify(counts));
  } else if (action === "retention") {
    console.log(JSON.stringify(await applyRetention(db), null, 2));
  } else {
    throw new PrivacyCliError("usage: privacy <export|delete|retention> [--email ...] [--by ...] [--confirm]");
  }
} finally {
  await sql.end();
}
