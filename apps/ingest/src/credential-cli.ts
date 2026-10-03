/**
 * Stores (rotates) an org's provider credential, envelope-encrypted.
 *
 *   TOKENGRID_CREDENTIAL=sk-ant-admin01-... pnpm --filter @tokengrid/ingest credential \
 *     --email admin@tokengrid.local --provider anthropic --kind admin --scope wrkspc_01...
 *
 * The secret is read from the TOKENGRID_CREDENTIAL environment variable, not
 * an argument, so it never appears in shell history or process listings.
 */
import { parseArgs } from "node:util";
import { and, eq, isNull } from "drizzle-orm";
import { createDb, encryptSecret, schema } from "@tokengrid/db";
import { PROVIDERS, type Provider } from "@tokengrid/shared";

export class CredentialCliError extends Error {
  override readonly name = "CredentialCliError";
}

const { values } = parseArgs({
  options: { email: { type: "string" }, provider: { type: "string" }, kind: { type: "string" }, scope: { type: "string" } },
});
const provider = values.provider as Provider | undefined;
const kind = values.kind ?? "api";
const secret = process.env.TOKENGRID_CREDENTIAL;
if (!values.email || !provider || !(PROVIDERS as readonly string[]).includes(provider) || (kind !== "api" && kind !== "admin")) {
  throw new CredentialCliError("usage: credential --email <org member> --provider <anthropic|openai> [--kind api|admin] [--scope <workspace/project id>]");
}
if (!secret) throw new CredentialCliError("set TOKENGRID_CREDENTIAL to the secret to store");

const { db, sql } = createDb(undefined, { max: 1 });
try {
  const [user] = await db.select({ orgId: schema.users.orgId }).from(schema.users).where(eq(schema.users.email, values.email));
  if (!user) throw new CredentialCliError(`no user with email ${values.email}`);
  const pc = schema.providerCredentials;
  await db.transaction(async (tx) => {
    await tx
      .update(pc)
      .set({ revokedAt: new Date() })
      .where(and(eq(pc.orgId, user.orgId), eq(pc.provider, provider), eq(pc.kind, kind), isNull(pc.revokedAt)));
    await tx.insert(pc).values({
      orgId: user.orgId,
      provider,
      kind,
      reconcileScope: kind === "admin" ? (values.scope ?? null) : null,
      // Admin keys get their own encryption context, so an admin ciphertext
      // copied into an API-key row fails authentication instead of being
      // forwarded upstream.
      ciphertext: encryptSecret(secret, { orgId: user.orgId, provider: kind === "admin" ? `${provider}#admin` : provider }),
    });
  });
  console.log(`stored ${provider} ${kind} credential for org ${user.orgId}${values.scope ? ` (scope ${values.scope})` : ""}`);
} finally {
  await sql.end();
}
