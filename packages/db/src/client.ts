import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

export class MissingDatabaseUrlError extends Error {
  override readonly name = "MissingDatabaseUrlError";
  constructor() {
    super("DATABASE_URL is not set. See .env.example.");
  }
}

export function createDb(url = process.env.DATABASE_URL, opts: { max?: number } = {}) {
  if (!url) throw new MissingDatabaseUrlError();
  const sql = postgres(url, {
    max: opts.max ?? 10,
    // Transaction-mode poolers (PgBouncer, Neon's pooled URL, typical for the
    // serverless dashboard) cannot hold prepared statements across clients.
    prepare: process.env.DATABASE_PREPARE !== "false",
    // Pinning the session to UTC keeps date_trunc and partition bounds in one
    // zone regardless of the server's configured TimeZone.
    connection: { TimeZone: "UTC" },
    onnotice: () => {},
  });
  return { db: drizzle(sql, { schema }), sql };
}

export type Database = ReturnType<typeof createDb>["db"];
