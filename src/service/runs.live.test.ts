// A real start on the Postgres World, found again by the attribute an event
// trigger seeds: the crash-window lookup against the World it runs on.
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createWorld } from "@workflow/world-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, test } from "vitest";
import { start } from "workflow/api";
import { setWorld } from "workflow/runtime";
import { findRunByAttribute, runIdTime, runStatuses } from "./runs.ts";

const adminUrl = new URL(
  process.env.WORKFLOW_POSTGRES_URL ?? "postgres://jigs:jigs@localhost:5439/jigs",
);
const database = `jigs_runs_${crypto.randomUUID().replaceAll("-", "")}`;
const testUrl = new URL(adminUrl);
testUrl.pathname = `/${database}`;
const admin = new Pool({ connectionString: adminUrl.toString(), max: 1 });
// Every delivery is acknowledged unread: the run only has to exist.
const server = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "application/json" }).end("{}");
});

let world: ReturnType<typeof createWorld>;
let oldBaseUrl: string | undefined;

beforeAll(async () => {
  await admin.query(`CREATE DATABASE "${database}"`);
  // West of UTC, where world-postgres' zone-less created_at reads back early.
  await admin.query(`ALTER DATABASE "${database}" SET timezone TO 'America/Los_Angeles'`);
  execFileSync("node_modules/.bin/bootstrap", [], {
    env: { ...process.env, WORKFLOW_POSTGRES_URL: testUrl.toString() },
    stdio: "ignore",
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  oldBaseUrl = process.env.WORKFLOW_LOCAL_BASE_URL;
  process.env.WORKFLOW_LOCAL_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  world = createWorld({ connectionString: testUrl.toString(), queueConcurrency: 1 });
  setWorld(world);
  await world.start();
});

afterAll(async () => {
  await world?.close?.();
  setWorld(undefined);
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
  if (oldBaseUrl === undefined) delete process.env.WORKFLOW_LOCAL_BASE_URL;
  else process.env.WORKFLOW_LOCAL_BASE_URL = oldBaseUrl;
  await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
  await admin.end();
});

test("a started run is found by its seeded attribute, whatever the server's time zone", async () => {
  const workflowName = "workflow//./workflows/respond//respond";
  const since = new Date();
  const run = await start({ workflowId: workflowName }, [{ page: "P1" }], {
    attributes: { "jigs.occurrence": "a".repeat(64) },
  });
  await start({ workflowId: workflowName }, [{ page: "P2" }], {
    attributes: { "jigs.occurrence": "b".repeat(64) },
  });

  expect(runIdTime(run.runId)).toBeGreaterThanOrEqual(since.getTime());
  // The skew this lookup must not stop on: created_at reads back hours early.
  const stored = await world.runs.get(run.runId, { resolveData: "none" });
  expect(stored.createdAt.getTime()).toBeLessThan(since.getTime() - 3_600_000);
  expect(
    await findRunByAttribute({
      workflowName,
      key: "jigs.occurrence",
      value: "a".repeat(64),
      since: new Date(since.getTime() - 1000),
    }),
  ).toBe(run.runId);
  expect((await runStatuses([run.runId])).has(run.runId)).toBe(true);
});
