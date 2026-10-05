import type { AddressInfo } from "node:net";
import { fromNodeHeaders } from "better-auth/node";
import type { Request } from "express";
import { adminOrganization, createAuth } from "./auth.ts";
import { readConfig } from "./config.ts";
import { connectDatabase, migrateDatabase } from "./db/database.ts";
import { createFactoryApi } from "./factory-api.ts";
import { createGitHubRoutes, GitHubTokens } from "./github.ts";
import { createLinearRoutes, LinearTokens } from "./linear.ts";
import { MessageWaiters } from "./messages.ts";
import { createPagerDutyRoutes, PagerDutyTokens } from "./pagerduty.ts";
import { startRetention } from "./retention.ts";
import { createHubApp } from "./server.ts";
import { createSlackRoutes } from "./slack.ts";
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

const waiters = new MessageWaiters();
const retention = startRetention(db, waiters, config.retentionDays);
const web = await createWebApp(
  { config, db, auth, waiters },
  process.env.NODE_ENV === "development",
);

const { encryptionKey, publicUrl } = config;
const linearTokens = new LinearTokens({ db, encryptionKey });
const adminOf = (request: Request) => adminOrganization(auth, fromNodeHeaders(request.headers));
const routers = [
  createFactoryApi({
    db,
    waiters,
    githubTokens: new GitHubTokens({ db, encryptionKey }),
    linearTokens,
    pagerDutyTokens: new PagerDutyTokens({ db, encryptionKey }),
    encryptionKey,
  }),
  createGitHubRoutes({ db, waiters, encryptionKey }),
  createLinearRoutes({
    db,
    waiters,
    encryptionKey,
    publicUrl,
    linearTokens,
    adminOrganization: adminOf,
  }),
  createSlackRoutes({ db, waiters, encryptionKey, publicUrl, adminOrganization: adminOf }),
  createPagerDutyRoutes({ db, waiters, encryptionKey }),
];
const server = createHubApp(auth, routers, web).listen(config.port, config.host, () => {
  const address = server.address() as AddressInfo;
  console.log(`hub listening on http://${address.address}:${address.port}`);
});

process.once("SIGTERM", () => {
  waiters.close();
  server.close(async (error) => {
    await retention.stop();
    await web.close();
    await db.$client.end();
    process.exit(error ? 1 : 0);
  });
});
