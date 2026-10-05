import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { z } from "zod";
import type { Factory } from "../workflow/factory.ts";
import { pagerduty } from "../workflow/pagerduty/source.ts";
import { createTriggerEngine } from "./event-triggers/engine.ts";
import { triggerChecks, triggerProviders } from "./event-triggers/view.ts";
import type { PreparedRun } from "./launch.ts";
import { pagerDutyIncidents } from "./pagerduty-incidents.ts";
import { eventTriggerId } from "./runs.ts";
import { memoryTriggerStore } from "./test-fixtures.ts";

const T0 = new Date("2026-09-29T12:00:00.000Z");
const minutes = (n: number) => new Date(T0.getTime() + n * 60_000);

test("the occurrence is the incident id, and params take PagerDuty's names only", async () => {
  const source = pagerDutyIncidents();
  expect(source.occurrence({ incident: "Q7", team: "infra" })).toBe("Q7");
  expect(() => source.occurrence({})).toThrow("no incident id");
  expect(source.params.safeParse({ team_ids: ["PT1"], urgencies: ["low"] }).success).toBe(true);
  expect(source.params.safeParse({ urgencies: ["urgent"] }).success).toBe(false);
  expect(source.params.safeParse({ service_ids: [] }).success).toBe(false);
  expect(source.params.safeParse({ statuses: ["acknowledged"] }).success).toBe(false);
});

// An `incident.triggered` delivery as PagerDuty's v3 webhooks send it.
const triggered = (): { event: Record<string, unknown> & { data: Record<string, unknown> } } =>
  JSON.parse(
    readFileSync(new URL("./fixtures/pagerduty-incident-triggered.json", import.meta.url), "utf8"),
  );
const withEvent = (fields: Record<string, unknown>, data: Record<string, unknown> = {}) => {
  const payload = triggered();
  return { event: { ...payload.event, ...fields, data: { ...payload.event.data, ...data } } };
};

test("a pushed incident.triggered is the incident, as of when it was created", async () => {
  const source = pagerDutyIncidents();

  const pushed = await source.fromPush({}, triggered());

  expect(pushed).toEqual({ inputs: { incident: "Q1" }, at: minutes(1) });
  expect(source.describe(pushed?.inputs ?? {})).toBe("pagerduty Q1");
});

test("any other webhook event is not an occurrence", async () => {
  const source = pagerDutyIncidents();
  for (const event_type of ["incident.acknowledged", "incident.resolved", "pagey.ping"])
    expect(await source.fromPush({}, withEvent({ event_type }))).toBeNull();
  expect(await source.fromPush({}, null)).toBeNull();
  expect(await source.fromPush({}, { ping: true })).toBeNull();
});

test("a pushed incident is filtered by the trigger's parameters", async () => {
  const source = pagerDutyIncidents();
  const push = (params: Parameters<typeof source.fromPush>[0], data = {}) =>
    source.fromPush(params, withEvent({}, data));
  expect(await push({ service_ids: ["PSVC001", "PSVC002"] })).not.toBeNull();
  expect(await push({ service_ids: ["PSVC002"] })).toBeNull();
  expect(await push({ team_ids: ["PTEAM01"] })).not.toBeNull();
  expect(await push({ team_ids: ["PTEAM02"] })).toBeNull();
  expect(await push({ team_ids: ["PTEAM01"] }, { teams: [] })).toBeNull();
  expect(await push({ urgencies: ["high"] })).not.toBeNull();
  expect(await push({ urgencies: ["low"] })).toBeNull();
});

test("an incident.triggered without an incident is refused rather than taken", async () => {
  const source = pagerDutyIncidents();
  await expect(source.fromPush({}, withEvent({}, { id: undefined }))).rejects.toThrow();
});

const respond: Factory = {
  workflows: {
    respond: {
      workflow: async () => undefined,
      inputs: z.object({ incident: z.string(), team: z.string() }),
    },
  },
  triggers: {
    pages: {
      workflow: "respond",
      source: pagerduty.incidents({ service_ids: ["PSVC001"] }),
      inputs: { team: "infra" },
    },
  },
};

// The engine over the real source, with an in-memory store and a World of
// plain objects.
function engineHarness() {
  let clock = T0;
  const memory = memoryTriggerStore(() => clock, T0);
  const runs: Array<{ runId: string; status: string; attribute: string }> = [];
  const starts: Array<{ inputs: unknown; triggerId: string }> = [];
  const sources = {
    "pagerduty.incidents": pagerDutyIncidents(),
  };
  const engine = createTriggerEngine(respond, {
    store: memory.store,
    sources,
    now: () => clock,
    log: () => {},
    factorySlug: () => "factory-a",
    runStatuses: async (ids) =>
      new Map(runs.filter((run) => ids.includes(run.runId)).map((run) => [run.runId, run.status])),
    findRunsByAttribute: async ({ value }) =>
      runs.filter((run) => run.attribute === value).map(({ runId, status }) => ({ runId, status })),
    liveRunsByAttribute: async () => {
      const live = new Map<string, Array<{ runId: string; status: string }>>();
      for (const run of runs)
        if (run.status === "running")
          live.set(run.attribute, [...(live.get(run.attribute) ?? []), run]);
      return live;
    },
    cancelRun: async () => {},
    prepareRun: async (_factory, _workflow, inputs): Promise<PreparedRun> => ({
      kind: "ready",
      launch: async (triggerId, attributes = {}) => {
        starts.push({ inputs, triggerId });
        const runId = `wrun_${starts.length}`;
        runs.push({ runId, status: "running", attribute: attributes["jigs.occurrence"] ?? "" });
        return runId;
      },
    }),
  });
  return {
    engine,
    memory,
    runs,
    starts,
    sources,
    at: (next: Date) => {
      clock = next;
    },
  };
}

// An `incident.triggered` for this incident, created at this time.
const triggeredFor = (id: string, createdAt: Date) =>
  withEvent({}, { id, created_at: createdAt.toISOString().replace(/\.\d{3}Z$/, "Z") });

test("each pushed incident starts one run, with the incident as its input", async () => {
  const h = engineHarness();
  await h.engine.arm();
  h.at(minutes(5));
  expect(await h.engine.push("pagerduty", triggeredFor("Q1", minutes(1)))).toEqual(["pages"]);
  expect(await h.engine.push("pagerduty", triggeredFor("Q2", minutes(4)))).toEqual(["pages"]);
  h.at(minutes(10));
  // Delivered again: the occurrence is already recorded.
  expect(await h.engine.push("pagerduty", triggeredFor("Q1", minutes(1)))).toEqual([]);
  expect(await h.engine.push("pagerduty", triggeredFor("Q3", minutes(8)))).toEqual(["pages"]);
  await h.engine.drain();

  expect(h.starts).toEqual([
    { inputs: { team: "infra", incident: "Q1" }, triggerId: eventTriggerId("pages", "Q1") },
    { inputs: { team: "infra", incident: "Q2" }, triggerId: eventTriggerId("pages", "Q2") },
    { inputs: { team: "infra", incident: "Q3" }, triggerId: eventTriggerId("pages", "Q3") },
  ]);
  expect(h.memory.state("pages", "Q1")?.occurredAt).toEqual(minutes(1));
});

test("an incident delivered again after its run ends does not start a second run", async () => {
  const h = engineHarness();
  await h.engine.arm();
  h.at(minutes(2));
  await h.engine.push("pagerduty", triggeredFor("Q1", minutes(1)));
  await h.engine.drain();
  expect(h.starts).toHaveLength(1);

  for (const run of h.runs) run.status = "completed";
  for (const at of [minutes(3), minutes(4), minutes(60)]) {
    h.at(at);
    await h.engine.push("pagerduty", triggeredFor("Q1", minutes(1)));
    await h.engine.drain();
  }

  expect(h.starts).toHaveLength(1);
  expect(h.memory.state("pages", "Q1")).toMatchObject({ state: "started", runId: "wrun_1" });
});

test("an incident created in the same second the trigger was first enabled starts its run", async () => {
  const h = engineHarness();
  // PagerDuty stamps whole seconds: created at 12:00:00Z, a moment before this enable.
  h.at(new Date(T0.getTime() + 285));
  await h.engine.arm();
  h.at(minutes(1));
  await h.engine.push("pagerduty", triggeredFor("Q1", T0));
  await h.engine.drain();
  expect(h.starts.map((start) => start.triggerId)).toEqual([eventTriggerId("pages", "Q1")]);
  expect(h.memory.state("pages", "Q1")?.occurredAt).toEqual(T0);
});

test("an incident created before the trigger was first enabled starts nothing", async () => {
  const h = engineHarness();
  await h.engine.arm();
  h.at(minutes(2));
  expect(await h.engine.push("pagerduty", triggeredFor("Q0", minutes(-1)))).toEqual([]);
  expect(h.starts).toEqual([]);
  expect(h.memory.rows.size).toBe(0);
});

test("the source is shipped, and its trigger reads PagerDuty for doctor", async () => {
  expect(triggerProviders(respond)).toEqual({ pages: "pagerduty" });
  const [check] = triggerChecks(respond);
  expect(await check?.run()).toEqual({ ok: true });
  const bad: Factory = {
    ...respond,
    triggers: {
      pages: {
        workflow: "respond",
        source: { kind: "pagerduty.incidents", params: { urgencies: ["urgent"] } },
        inputs: { team: "infra" },
      },
    },
  };
  expect(await triggerChecks(bad)[0]?.run()).toMatchObject({
    ok: false,
    reason: expect.stringContaining("urgencies"),
  });
});

test("a pushed incident on a service the trigger does not watch starts nothing", async () => {
  const h = engineHarness();
  await h.engine.arm();
  h.at(minutes(2));
  const elsewhere = withEvent({}, { service: { id: "PSVC009" } });
  expect(await h.engine.push("pagerduty", elsewhere)).toEqual([]);
  expect(h.memory.rows.size).toBe(0);
});
