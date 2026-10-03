import { createDb, type Database } from "@tokengrid/db";

const globalForDb = globalThis as unknown as { tokengridDb?: Database };

/** One pool per process; Next's dev server re-evaluates modules on every edit and would otherwise leak pools. */
export function db(): Database {
  globalForDb.tokengridDb ??= createDb(undefined, { max: 5 }).db;
  return globalForDb.tokengridDb;
}
