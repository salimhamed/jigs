import type { AddressInfo } from "node:net";
import { fromNodeHeaders } from "better-auth/node";
import type { Request } from "express";
import { adminOrganization, createAuth } from "./auth.ts";
import { readConfig, signInRedirectUri } from "./config.ts";
import { connectDatabase, migrateDatabase } from "./db/database.ts";
import { createFactoryApi } from "./factory-api.ts";
import { createGitHubRoutes } from "./github.ts";
import { createLinearRoutes, LinearTokens } from "./linear.ts";
import { MessageWaiters } from "./messages.ts";
import { createPagerDutyRoutes } from "./pagerduty.ts";
import { startRetention } from "./retention.ts";
import { createHubApp } from "./server.ts";
import { Shutdown } from "./shutdown.ts";
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
  createFactoryApi({ db, waiters, encryptionKey, linearTokens }),
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
const shutdown = new Shutdown();
const server = createHubApp(auth, routers, web, shutdown).listen(
  config.port,
  config.host,
  (error?: NodeJS.ErrnoException) => {
    if (error) {
      const reason = error.code === "EADDRINUSE" ? "address already in use" : error.message;
      console.error(`hub could not listen on ${config.host}:${config.port}: ${reason}`);
      process.exit(1);
    }
    const address = server.address() as AddressInfo;
    console.log(`hub listening on http://${address.address}:${address.port}`);
    console.log(`sign-in app Homepage URL: ${publicUrl.origin}`);
    console.log(`sign-in app Redirect URI: ${signInRedirectUri(publicUrl)}`);
  },
);
// Outlast a load balancer's idle timeout (60 seconds on AWS), or it can send a
// request down a connection the hub is closing and answer 502.
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;

process.once("SIGTERM", async () => {
  waiters.close();
  let code = 0;
  try {
    await shutdown.close(server);
  } catch (error) {
    console.error(`could not stop the hub: ${String(error)}`);
    code = 1;
  }
  await retention.stop();
  await web.close();
  await db.$client.end();
  process.exit(code);
});
