import type { AddressInfo } from "node:net";
import { createAuth } from "./auth.ts";
import { readConfig } from "./config.ts";
import { connectDatabase, migrateDatabase } from "./db/database.ts";
import { createFactoryApi } from "./factory-api.ts";
import { MessageWaiters } from "./messages.ts";
import { startRetention } from "./retention.ts";
import { createHubApp } from "./server.ts";
import { createWebApp } from "./web.ts";

let config: ReturnType<typeof readConfig>;
try {
  config = readConfig(process.env);
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}

const db = connectDatabase(config.databaseUrl);
await migrateDatabase(db);
const auth = createAuth(config, db);
const web = await createWebApp({ config, db, auth }, process.env.NODE_ENV === "development");

const waiters = new MessageWaiters();
const retention = startRetention(db, waiters, config.retentionDays);

const server = createHubApp(auth, createFactoryApi(db, waiters), web).listen(
  config.port,
  config.host,
  () => {
    const address = server.address() as AddressInfo;
    console.log(`hub listening on http://${address.address}:${address.port}`);
  },
);

process.once("SIGTERM", () => {
  waiters.close();
  server.close(async (error) => {
    await retention.stop();
    await web.close();
    await db.$client.end();
    process.exit(error ? 1 : 0);
  });
});
