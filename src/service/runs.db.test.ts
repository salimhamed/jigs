// A real start on the Postgres World, found again by the attribute an event
// trigger seeds, and a run whose queue write failed cancelled before it can run.
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createWorld } from "@workflow/world-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, expect } from "vitest";
import { start } from "workflow/api";
import { setWorld } from "workflow/runtime";
import { z } from "zod";
import {
  databaseUrl,
  dbTest,
  dropDatabaseOnceIdle,
  postgresAdminUrl,
} from "../db-test-fixtures.ts";
import type { Factory } from "../workflow/factory.ts";
import {
  cancelRun,
  findRunsByAttribute,
  liveRunsByAttribute,
  runIdTime,
  runStatuses,
} from "./runs.ts";
import { prepareRun } from "./trigger.ts";

const database = `jigs_runs_${crypto.randomUUID().replaceAll("-", "")}`;
const testUrl = databaseUrl(database);
const admin = new Pool({ connectionString: postgresAdminUrl.toString(), max: 1 });
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
  // West of UTC, where world-postgres' zone-less created_at reads back early.
  await admin.query(`ALTER DATABASE "${database}" SET timezone TO 'America/Los_Angeles'`);
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
  await dropDatabaseOnceIdle(admin, database);
  await admin.end();
});

const workflowName = "workflow//./workflows/respond//respond";
const factory = {
  workflows: {
    respond: {
      workflow: { workflowId: workflowName } as never,
      inputs: z.object({ page: z.string() }),
    },
  },
} satisfies Factory;

const launch = async (value: string) => {
  const prepared = await prepareRun(factory, "respond", { page: value });
  if (prepared.kind !== "ready") throw new Error(prepared.kind);
  return prepared.launch(`trigger:pages:${value}`, { "jigs.occurrence": value });
};

dbTest("a started run is found by its attribute, whatever the server's time zone", async () => {
  const since = new Date();
  const runId = await launch("a".repeat(64));
  await launch("b".repeat(64));

  expect(runIdTime(runId)).toBeGreaterThanOrEqual(since.getTime());
  // The skew the lookup must not stop on: created_at reads back hours early.
  const stored = await world.runs.get(runId, { resolveData: "none" });
  expect(stored.createdAt.getTime()).toBeLessThan(since.getTime() - 3_600_000);
  expect(
    await findRunsByAttribute({
      workflowName,
      key: "jigs.occurrence",
      value: "a".repeat(64),
      since: new Date(since.getTime() - 60_000),
    }),
  ).toEqual([{ runId, status: "pending" }]);
});

dbTest(
  "a run whose queue write failed is found pending and cancelled before any delivery",
  async () => {
    const value = "c".repeat(64);
    const since = new Date(Date.now() - 60_000);
    const failing = Object.create(world, {
      queue: {
        value: async () => {
          throw new Error("injected queue failure");
        },
      },
    });
    await expect(
      start({ workflowId: workflowName }, [{ page: "P3", triggerId: "trigger:pages:P3" }], {
        world: failing,
        attributes: { "jigs.occurrence": value },
      }),
    ).rejects.toThrow("injected queue failure");

    const [orphan] = await findRunsByAttribute({
      workflowName,
      key: "jigs.occurrence",
      value,
      since,
    });
    expect(orphan?.status).toBe("pending");
    await cancelRun(orphan?.runId as string);
    expect(await runStatuses([orphan?.runId as string])).toEqual(
      new Map([[orphan?.runId, "cancelled"]]),
    );
    // Cancelled before anything queued it: even the World's own restart
    // recovery, which queues only pending and running runs, leaves it alone.
    await world.close?.();
    world = createWorld({ connectionString: testUrl.toString(), queueConcurrency: 1 });
    setWorld(world);
    await world.start();
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(deliveries.get(orphan?.runId as string)).toBeUndefined();
  },
);

dbTest(
  "a start whose run creation fails while its queue accepts throws, and its delivery creates the run",
  async () => {
    const value = "d".repeat(64);
    const since = new Date(Date.now() - 60_000);
    // world-postgres passes a raw pg error through, which start() does not
    // treat as retryable.
    const failing = Object.create(world, {
      events: {
        value: {
          ...world.events,
          create: async () => {
            throw new Error("Connection terminated unexpectedly");
          },
        },
      },
    });
    await expect(
      start({ workflowId: workflowName }, [{ page: "P4", triggerId: "trigger:pages:P4" }], {
        world: failing,
        attributes: { "jigs.occurrence": value },
      }),
    ).rejects.toThrow("Connection terminated unexpectedly");
    const lookup = () =>
      findRunsByAttribute({ workflowName, key: "jigs.occurrence", value, since });
    expect(await lookup()).toEqual([]);

    // What the runtime does with the first delivery: run_started with the
    // queued input creates the run, attributes included.
    const delivered = () =>
      [...deliveries.entries()].find(([, bodies]) =>
        bodies.some((body) => JSON.stringify(body).includes(value)),
      );
    await expect.poll(delivered, { timeout: 15_000 }).toBeDefined();
    const [runId, bodies] = delivered() as [string, Array<{ runInput: Record<string, unknown> }>];
    const runInput = bodies[0]?.runInput as Record<string, unknown>;
    await world.events.create(runId, {
      eventType: "run_started",
      specVersion: runInput.specVersion,
      eventData: {
        input: runInput.input,
        deploymentId: runInput.deploymentId,
        workflowName: runInput.workflowName,
        executionContext: runInput.executionContext,
        attributes: runInput.attributes,
      },
    } as never);
    expect(await lookup()).toEqual([{ runId, status: "running" }]);
  },
);

dbTest(
  "live runs are listed by the status filter and grouped by their occurrence attribute",
  async () => {
    const [one, two, three] = ["g".repeat(64), "h".repeat(64), "i".repeat(64)];
    const first = await launch(one);
    const second = await launch(one);
    const other = await launch(two);
    const done = await launch(three);
    await cancelRun(done);

    const live = await liveRunsByAttribute(workflowName, "jigs.occurrence");
    expect(
      live
        .get(one)
        ?.map((run) => run.runId)
        .sort(),
    ).toEqual([first, second].sort());
    expect(live.get(two)).toEqual([{ runId: other, status: "pending" }]);
    // A cancelled run is not live.
    expect(live.has(three)).toBe(false);
    // Let the queue hand over these runs' deliveries before the World closes.
    await expect
      .poll(() => [first, second, other].every((runId) => deliveries.has(runId)), {
        timeout: 15_000,
      })
      .toBe(true);
  },
);
