import { fileURLToPath } from "node:url";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { packageRoot } from "../package-root.ts";
import * as schema from "./schema.ts";

export type HubDatabase = NodePgDatabase<typeof schema> & { $client: Pool };

/** A transaction on the hub's database. */
export type Transaction = Parameters<Parameters<HubDatabase["transaction"]>[0]>[0];

const migrationsFolder = fileURLToPath(new URL("migrations/", packageRoot));

/** Open the hub's pool. The caller ends it with `db.$client.end()`. */
export function connectDatabase(url: string): HubDatabase {
  const pool = new Pool({ connectionString: url });
  // pg drops a failed idle client itself; without a listener the error kills the hub.
  pool.on("error", (error) => {
    console.error(`[db] idle PostgreSQL connection failed: ${error.message}`);
  });
  return drizzle(pool, { schema });
}

/** Apply every migration in `migrations/` that this database has not run yet. */
export async function migrateDatabase(db: HubDatabase): Promise<void> {
  await migrate(db, { migrationsFolder });
}
