import type { AddressInfo } from "node:net";
import { readConfig } from "./config.ts";
import { connectDatabase, migrateDatabase } from "./db/database.ts";
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
const web = await createWebApp(config, process.env.NODE_ENV === "development");

const server = createHubApp(web).listen(config.port, config.host, () => {
  const address = server.address() as AddressInfo;
  console.log(`hub listening on http://${address.address}:${address.port}`);
});

process.once("SIGTERM", () => {
  server.close(async (error) => {
    await web.close();
    await db.$client.end();
    process.exit(error ? 1 : 0);
  });
});
