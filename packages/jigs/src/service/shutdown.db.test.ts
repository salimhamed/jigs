import { execFileSync } from "node:child_process";
import { type AddressInfo, createServer } from "node:net";
import { createWorld } from "@workflow/world-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, expect } from "vitest";
import {
  databaseUrl,
  dbTest,
  dropDatabaseOnceIdle,
  postgresAdminUrl,
} from "../db-test-fixtures.ts";

// Its own database, bootstrapped with @workflow/world-postgres's `bootstrap`:
// the workflow schema and graphile's tables stay out of the admin database.
const database = `jigs_shutdown_${crypto.randomUUID().replaceAll("-", "")}`;
const url = databaseUrl(database).toString();
const admin = new Pool({ connectionString: postgresAdminUrl.toString(), max: 1 });

// world-postgres starts graphile's runner inside start() only when it can
// reach the service port within 200ms; a bare listener stands in for the
// service so the runner starts and the shutdown contract is exercised.
const service = createServer();
const baseUrlBefore = process.env.WORKFLOW_LOCAL_BASE_URL;
beforeAll(async () => {
  await admin.query(`CREATE DATABASE "${database}"`);
  execFileSync("node_modules/.bin/bootstrap", [], {
    env: { ...process.env, WORKFLOW_POSTGRES_URL: url },
    stdio: "ignore",
  });
  await new Promise<void>((resolve) => service.listen(0, "127.0.0.1", resolve));
  const { port } = service.address() as AddressInfo;
  process.env.WORKFLOW_LOCAL_BASE_URL = `http://127.0.0.1:${port}`;
});
afterAll(async () => {
  if (baseUrlBefore === undefined) delete process.env.WORKFLOW_LOCAL_BASE_URL;
  else process.env.WORKFLOW_LOCAL_BASE_URL = baseUrlBefore;
  await new Promise<void>((resolve) => service.close(() => resolve()));
  await dropDatabaseOnceIdle(admin, database);
  await admin.end();
});

const handlerNames = (signal: NodeJS.Signals) =>
  process.listeners(signal).map((listener) => listener.name);

dbTest(
  "application-managed shutdown adds no graphile signal handler, and close() is clean",
  async () => {
    const world = createWorld({ connectionString: url, applicationManagedShutdown: true });
    const beforeTerm = handlerNames("SIGTERM");
    const beforeInt = handlerNames("SIGINT");

    await world.start();

    expect(handlerNames("SIGTERM")).toEqual(beforeTerm);
    expect(handlerNames("SIGINT")).toEqual(beforeInt);
    expect(handlerNames("SIGTERM")).not.toContain("gracefulHandler");
    expect(handlerNames("SIGINT")).not.toContain("gracefulHandler");

    expect(world.close).toBeDefined();
    await expect(world.close?.()).resolves.toBeUndefined();
  },
);
