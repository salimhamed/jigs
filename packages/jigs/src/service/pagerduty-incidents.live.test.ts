// A real incident on the PagerDuty sandbox service, pushed as the
// `incident.triggered` event the hub would pass on and started as a real run on
// a Postgres World of its own. Runs only with
// JIGS_TEST_PAGERDUTY_TOKEN (a PagerDuty app's token), PAGERDUTY_FROM and
// PAGERDUTY_EVENTS_ROUTING_KEY set. Other tests may open incidents on the same
// service at the same time, so only this test's own incident is asserted on.
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createWorld } from "@workflow/world-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { setWorld } from "workflow/runtime";
import { z } from "zod";
import { databaseUrl, postgresAdminUrl } from "../db-test-fixtures.ts";
import { waitForLiveIncident } from "../providers/test-fixtures.ts";
import { connectRegistry, ensureRegistry, type RegistrySql } from "../steps/runtime/registry.ts";
import type { Factory } from "../workflow/factory.ts";
import { pagerduty } from "../workflow/pagerduty/source.ts";
import { createTriggerEngine } from "./event-triggers/engine.ts";
import { triggerStore } from "./event-triggers/store.ts";
import { PAGERDUTY_INCIDENTS } from "./pagerduty-incidents.ts";
import { findRunsByAttribute } from "./runs.ts";

const env = (name: string) => (process.env[name] === "" ? undefined : process.env[name]);
const from = env("PAGERDUTY_FROM");
const routingKey = env("PAGERDUTY_EVENTS_ROUTING_KEY");
const token = env("JIGS_TEST_PAGERDUTY_TOKEN");
const configured = token !== undefined && from !== undefined && routingKey !== undefined;
const SERVICE = env("PAGERDUTY_SERVICE_ID") ?? "P48FPG2";
const SLUG = "pagerduty-live";

describe.skipIf(!configured)("a PagerDuty incident trigger, live", () => {
  const database = `jigs_pd_trigger_${crypto.randomUUID().replaceAll("-", "")}`;
  const testUrl = databaseUrl(database);
  const admin = new Pool({ connectionString: postgresAdminUrl.toString(), max: 1 });
  // Deliveries are acknowledged unread: the run only has to exist.
  const server = createServer(async (req, res) => {
    await req.toArray();
    res.writeHead(200, { "content-type": "application/json" }).end("{}");
  });
  let world: ReturnType<typeof createWorld> | undefined;
  let db: RegistrySql | undefined;
  let oldBaseUrl: string | undefined;

  const dedupKey = `jigs-live-trigger-${crypto.randomUUID()}`;
  const enqueue = (action: "trigger" | "resolve") =>
    fetch("https://events.pagerduty.com/v2/enqueue", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        routing_key: routingKey,
        event_action: action,
        dedup_key: dedupKey,
        ...(action === "trigger"
          ? {
              payload: {
                summary: "jigs live trigger test: safe to ignore, resolves itself",
                source: "jigs pagerduty-incidents.live.test.ts",
                severity: "info",
              },
            }
          : {}),
      }),
    });

  beforeAll(async () => {
    await admin.query(`CREATE DATABASE "${database}"`);
    execFileSync("node_modules/.bin/bootstrap", [], {
      env: { ...process.env, WORKFLOW_POSTGRES_URL: testUrl.toString() },
      stdio: "ignore",
    });
    db = connectRegistry(testUrl.toString(), { max: 2 });
    await ensureRegistry(db);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    oldBaseUrl = process.env.WORKFLOW_LOCAL_BASE_URL;
    process.env.WORKFLOW_LOCAL_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    world = createWorld({ connectionString: testUrl.toString(), queueConcurrency: 1 });
    setWorld(world);
    await world.start();
  });

  afterAll(async () => {
    // First, whatever else failed: no test incident is left open.
    await enqueue("resolve");
    await world?.close?.();
    setWorld(undefined);
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    if (oldBaseUrl === undefined) delete process.env.WORKFLOW_LOCAL_BASE_URL;
    else process.env.WORKFLOW_LOCAL_BASE_URL = oldBaseUrl;
    await db?.$client.end();
    await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
    await admin.end();
  });

  const workflowName = "workflow//./workflows/respond//respond";
  const factory: Factory = {
    workflows: {
      respond: {
        workflow: { workflowId: workflowName } as never,
        inputs: z.object({ installationName: z.string(), incident: z.string(), team: z.string() }),
      },
    },
    triggers: {
      pages: {
        workflow: "respond",
        source: pagerduty.incidents({ installationName: "live", services: [SERVICE] }),
        inputs: { team: "live" },
        // Other tests' incidents on the sandbox start runs here too.
        maxActive: 100,
      },
    },
  };

  test("a triggered incident starts one run, and a second delivery starts no other", async () => {
    const store = triggerStore(db as RegistrySql, SLUG);
    const engine = createTriggerEngine(factory, {
      store,
      sources: { "pagerduty.incidents": PAGERDUTY_INCIDENTS },
      factorySlug: () => SLUG,
      log: () => {},
    });
    await engine.arm();
    expect((await enqueue("trigger")).status).toBe(202);

    const mine = await waitForLiveIncident(token ?? "", dedupKey);
    const id = mine.id;
    const triggered = {
      installationName: "live",
      payload: {
        event: {
          event_type: "incident.triggered",
          data: {
            id,
            created_at: mine.created_at,
            service: { id: mine.service.id },
            teams: [],
            urgency: mine.urgency,
          },
        },
      },
    };

    const row = async () =>
      (
        await (db as RegistrySql).$client.query<{
          state: string;
          run_id: string | null;
          inputs: Record<string, unknown>;
          attribute: string;
        }>(
          "SELECT state, run_id, inputs, attribute FROM jigs_triggers WHERE factory = $1 AND trigger = 'pages' AND occurrence = $2",
          [SLUG, id],
        )
      ).rows[0];

    expect(await engine.push("pagerduty", triggered)).toEqual(["pages"]);
    for (let attempt = 0; attempt < 20 && (await row())?.state !== "started"; attempt += 1) {
      await engine.drain();
      if ((await row())?.state !== "started")
        await new Promise((resolve) => setTimeout(resolve, 3_000));
    }
    const started = await row();
    expect(started).toMatchObject({
      state: "started",
      inputs: { installationName: "live", incident: id },
    });

    expect(await engine.push("pagerduty", triggered)).toEqual([]);
    await engine.drain();
    const runs = await findRunsByAttribute({
      workflowName,
      key: "jigs.occurrence",
      value: started?.attribute as string,
      since: new Date(Date.now() - 10 * 60_000),
    });
    expect(runs.map((run) => run.runId)).toEqual([started?.run_id]);
    await engine.stop();
  });
});
