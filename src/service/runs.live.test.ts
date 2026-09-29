// A real start on the Postgres World under a run ID the caller chose: what an
// event trigger relies on to know its run before the start, and to retry it.
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createWorld } from "@workflow/world-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, test } from "vitest";
import { setWorld } from "workflow/runtime";
import { z } from "zod";
import type { Factory } from "../workflow/factory.ts";
import { runStatuses } from "./runs.ts";
import { startRun } from "./trigger.ts";

const adminUrl = new URL(
  process.env.WORKFLOW_POSTGRES_URL ?? "postgres://jigs:jigs@localhost:5439/jigs",
);
const database = `jigs_runs_${crypto.randomUUID().replaceAll("-", "")}`;
const testUrl = new URL(adminUrl);
testUrl.pathname = `/${database}`;
const admin = new Pool({ connectionString: adminUrl.toString(), max: 1 });
// Every delivery is counted and acknowledged unread: the run only has to exist.
const deliveries = new Map<string, number>();
const server = createServer(async (req, res) => {
  const text = Buffer.concat(await req.toArray()).toString();
  const runId = text === "" ? undefined : (JSON.parse(text) as { runId?: string }).runId;
  if (runId !== undefined) deliveries.set(runId, (deliveries.get(runId) ?? 0) + 1);
  res.writeHead(200, { "content-type": "application/json" }).end("{}");
});

let world: ReturnType<typeof createWorld>;
let oldBaseUrl: string | undefined;

beforeAll(async () => {
  await admin.query(`CREATE DATABASE "${database}"`);
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

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
function runIdNow(): string {
  let time = "";
  for (let ms = Date.now(), i = 0; i < 10; i += 1, ms = Math.floor(ms / 32))
    time = CROCKFORD[ms % 32] + time;
  return `wrun_${time}${"0123456789ABCDEF"}`;
}

const workflowName = "workflow//./workflows/respond//respond";
const factory = {
  workflows: {
    respond: {
      workflow: { workflowId: workflowName } as never,
      inputs: z.object({ page: z.string() }),
    },
  },
} satisfies Factory;

test("a start under a chosen run ID creates that run, and a retry of it lands on the same one", async () => {
  const runId = runIdNow();
  expect(await startRun(factory, "respond", { page: "P1" }, "trigger:pages:P1", runId)).toEqual({
    kind: "started",
    runId,
  });
  expect(await startRun(factory, "respond", { page: "P1" }, "trigger:pages:P1", runId)).toEqual({
    kind: "started",
    runId,
  });

  const listed = await world.runs.list({ workflowName, resolveData: "none" });
  expect(listed.data.map((run) => run.runId)).toEqual([runId]);
  expect((await runStatuses([runId])).has(runId)).toBe(true);
  // One run, but each start still queued its own delivery: why the engine
  // never retries an attempt while its first start may still be in flight.
  await expect.poll(() => deliveries.get(runId) ?? 0, { timeout: 15_000 }).toBe(2);
});
