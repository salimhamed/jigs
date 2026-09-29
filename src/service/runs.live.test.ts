// The Postgres World under an event trigger's two steps: the run created under
// an ID the row already holds, with nothing queued, then queued by jigs with a
// delivery that carries no input. The compiled e2e proves a run so queued
// twice executes once; this proves what reaches the queue.
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createWorld } from "@workflow/world-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, test } from "vitest";
import { setWorld } from "workflow/runtime";
import { z } from "zod";
import type { Factory } from "../workflow/factory.ts";
import { enqueueRun, runStatuses } from "./runs.ts";
import { prepareRun } from "./trigger.ts";

const adminUrl = new URL(
  process.env.WORKFLOW_POSTGRES_URL ?? "postgres://jigs:jigs@localhost:5439/jigs",
);
const database = `jigs_runs_${crypto.randomUUID().replaceAll("-", "")}`;
const testUrl = new URL(adminUrl);
testUrl.pathname = `/${database}`;
const admin = new Pool({ connectionString: adminUrl.toString(), max: 1 });
// Every delivery is kept and acknowledged unread: the run only has to exist.
const deliveries = new Map<string, Array<Record<string, unknown>>>();
const server = createServer(async (req, res) => {
  const text = Buffer.concat(await req.toArray()).toString();
  const body = text === "" ? {} : (JSON.parse(text) as Record<string, unknown>);
  if (typeof body.runId === "string")
    deliveries.set(body.runId, [...(deliveries.get(body.runId) ?? []), body]);
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

const launch = async (runId: string) => {
  const prepared = await prepareRun(factory, "respond", { page: "P1" });
  if (prepared.kind !== "ready") throw new Error(prepared.kind);
  return prepared.launch("trigger:pages:P1", runId);
};

test("a launch under a chosen ID creates that run and queues nothing, however often it repeats", async () => {
  const runId = runIdNow();
  expect(await launch(runId)).toBe(runId);
  expect(await launch(runId)).toBe(runId);

  const listed = await world.runs.list({ workflowName, resolveData: "none" });
  expect(listed.data.map((run) => run.runId)).toEqual([runId]);
  expect(await runStatuses([runId])).toEqual(new Map([[runId, "pending"]]));
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  expect(deliveries.get(runId)).toBeUndefined();
});

test("a queued run's deliveries name it and carry no input, however often it is queued", async () => {
  const runId = runIdNow().replace(/.$/, "X");
  await launch(runId);
  await enqueueRun(runId);
  await enqueueRun(runId);
  await expect.poll(() => deliveries.get(runId)?.length ?? 0, { timeout: 15_000 }).toBe(2);
  for (const body of deliveries.get(runId) ?? []) expect(body).not.toHaveProperty("runInput");
});
