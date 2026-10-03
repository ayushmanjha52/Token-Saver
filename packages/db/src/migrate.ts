import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDb } from "./client.js";
import { ensureUsagePartitions } from "./partitions.js";

const { db, sql } = createDb(undefined, { max: 1 });
try {
  await migrate(db, { migrationsFolder: fileURLToPath(new URL("../migrations", import.meta.url)) });
  await ensureUsagePartitions(db);
  console.log("migrations applied; usage_events partitions ensured");
} finally {
  await sql.end();
}
