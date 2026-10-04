import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { z } from "zod";
import type { PagerDutyIdentity } from "../config/factory-config.ts";
import { createPagerDutyClient, type PagerDutyIncident } from "../providers/pagerduty.ts";
import type { PagerDutyAuth } from "../providers/pagerduty-auth.ts";
import type { Factory } from "../workflow/factory.ts";
import { pagerduty } from "../workflow/pagerduty/source.ts";
import { POLL_OVERLAP_MS, pagerDutyIncidents } from "./pagerduty-incidents.ts";
import { eventTriggerId } from "./runs.ts";
import { memoryTriggerStore } from "./test-fixtures.ts";
import type { PreparedRun } from "./trigger.ts";
import { createTriggerEngine, triggerChecks, triggerProviders } from "./triggers.ts";

const T0 = new Date("2026-09-29T12:00:00.000Z");
const minutes = (n: number) => new Date(T0.getTime() + n * 60_000);

const identity: PagerDutyIdentity = {
  mode: "app",
  subdomain: "acme",
  region: "us",
  from: "oncall@example.com",
};
const auth: PagerDutyAuth = {
  identity,
  bearer: async () => "token",
  invalidate: () => {},
};

// A list-incidents record as PagerDuty returns it, trimmed to what the client reads.
const incident = (
  id: string,
  createdAt: Date,
  status: PagerDutyIncident["status"] = "triggered",
): PagerDutyIncident => ({
  id,
  incident_number: Number.parseInt(id.replace(/\D/g, ""), 10) || 1,
  title: `Checkout latency ${id}`,
  status,
  urgency: "high",
  created_at: createdAt.toISOString().replace(/\.\d{3}Z$/, "Z"),
  html_url: `https://acme.pagerduty.com/incidents/${id}`,
  service: { id: "PSVC001", type: "service_reference", summary: "checkout" },
  assignments: [],
  escalation_policy: { id: "PEP001", type: "escalation_policy_reference" },
});

// Serves the queued replies in order, each an `/incidents` listing split into
// pages of the size asked for, and keeps every URL requested.
function recordedApi() {
  const replies: PagerDutyIncident[][] = [];
  const urls: URL[] = [];
  let current: PagerDutyIncident[] = [];
  const fetch = (async (input: string | URL) => {
    const url = new URL(String(input));
    urls.push(url);
    const offset = Number(url.searchParams.get("offset"));
    const limit = Number(url.searchParams.get("limit"));
    if (offset === 0) current = replies.shift() ?? [];
    const page = current.slice(offset, offset + limit);
    return new Response(
      JSON.stringify({
        incidents: page,
        limit,
        offset,
        total: null,
        more: offset + page.length < current.length,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof globalThis.fetch;
  return { replies, urls, client: createPagerDutyClient(identity, { auth, fetch }) };
}

test("a poll lists incidents of every status with the source's own filters, from just behind its cursor", async () => {
  const api = recordedApi();
  api.replies.push([incident("Q1", minutes(-2)), incident("Q2", minutes(-1))]);
  const source = pagerDutyIncidents({ client: () => api.client, now: () => T0 });
  const params = source.params.parse(
    pagerduty.incidents({ service_ids: ["PSVC001", "PSVC002"], urgencies: ["high"] }).params,
  );

  const seen = await source.poll(params, minutes(-5).toISOString(), minutes(-60));

  expect(seen).toEqual({
    occurrences: [
      { inputs: { incident: "Q1" }, at: minutes(-2) },
      { inputs: { incident: "Q2" }, at: minutes(-1) },
    ],
    cursor: T0.toISOString(),
  });
  const [url] = api.urls;
  expect(url?.pathname).toBe("/incidents");
  expect(url?.searchParams.getAll("service_ids[]")).toEqual(["PSVC001", "PSVC002"]);
  expect(url?.searchParams.getAll("urgencies[]")).toEqual(["high"]);
  expect(url?.searchParams.getAll("statuses[]")).toEqual(["triggered", "acknowledged", "resolved"]);
  expect(url?.searchParams.has("team_ids[]")).toBe(false);
  expect(url?.searchParams.get("since")).toBe(
    new Date(minutes(-5).getTime() - POLL_OVERLAP_MS).toISOString(),
  );
  // Stated, because PagerDuty otherwise ends the range a month after `since`.
  expect(new Date(url?.searchParams.get("until") as string) >= T0).toBe(true);
});

test("a poll pages through every incident, 100 at a time", async () => {
  const api = recordedApi();
  api.replies.push(
    Array.from({ length: 230 }, (_, index) => incident(`Q${index + 1}`, minutes(-1))),
  );
  const source = pagerDutyIncidents({ client: () => api.client, now: () => T0 });

  expect((await source.poll({}, undefined, minutes(-5))).occurrences).toHaveLength(230);
  expect(
    api.urls.map((url) => [url.searchParams.get("offset"), url.searchParams.get("limit")]),
  ).toEqual([
    ["0", "100"],
    ["100", "100"],
    ["200", "100"],
  ]);
});

test("after a long downtime the range stays within what PagerDuty accepts", async () => {
  const api = recordedApi();
  const source = pagerDutyIncidents({ client: () => api.client, now: () => T0 });

  const longAgo = new Date(T0.getTime() - 400 * 24 * 60 * 60_000);
  await source.poll({}, longAgo.toISOString(), longAgo);

  const [url] = api.urls;
  const since = new Date(url?.searchParams.get("since") as string).getTime();
  const until = new Date(url?.searchParams.get("until") as string).getTime();
  expect(until - since).toBeLessThan(180 * 24 * 60 * 60_000);
  expect(until).toBeGreaterThanOrEqual(T0.getTime());
});

test("a cursor behind the floor reads from the floor", async () => {
  const api = recordedApi();
  const source = pagerDutyIncidents({ client: () => api.client, now: () => T0 });

  await source.poll({}, minutes(-600).toISOString(), minutes(-60));

  expect(api.urls[0]?.searchParams.get("since")).toBe(
    new Date(minutes(-60).getTime() - POLL_OVERLAP_MS).toISOString(),
  );
  expect(source.cursor.safeParse("not a time").success).toBe(false);
});

test("the occurrence is the incident id, and params take PagerDuty's names only", async () => {
  const source = pagerDutyIncidents({ client: () => recordedApi().client });
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

test("a pushed incident.triggered is the same occurrence the poll finds", async () => {
  const api = recordedApi();
  api.replies.push([incident("Q1", minutes(1))]);
  const source = pagerDutyIncidents({ client: () => api.client, now: () => T0 });

  const pushed = await source.fromPush({}, triggered());

  expect(pushed).toEqual({ inputs: { incident: "Q1" }, at: minutes(1) });
  expect((await source.poll({}, undefined, T0)).occurrences).toEqual([pushed]);
  expect(source.describe(pushed?.inputs ?? {})).toBe("pagerduty Q1");
});

test("any other webhook event is not an occurrence", async () => {
  const source = pagerDutyIncidents({ client: () => recordedApi().client });
  for (const event_type of ["incident.acknowledged", "incident.resolved", "pagey.ping"])
    expect(await source.fromPush({}, withEvent({ event_type }))).toBeNull();
  expect(await source.fromPush({}, null)).toBeNull();
  expect(await source.fromPush({}, { ping: true })).toBeNull();
});

test("a pushed incident is filtered as the poll's own parameters filter it", async () => {
  const source = pagerDutyIncidents({ client: () => recordedApi().client });
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
  const source = pagerDutyIncidents({ client: () => recordedApi().client });
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

// The engine over the real source and client, with the recorded API, an
// in-memory store and a World of plain objects.
function engineHarness() {
  const api = recordedApi();
  let clock = T0;
  const memory = memoryTriggerStore(() => clock, T0);
  const runs: Array<{ runId: string; status: string; attribute: string }> = [];
  const starts: Array<{ inputs: unknown; triggerId: string }> = [];
  const sources = {
    "pagerduty.incidents": pagerDutyIncidents({ client: () => api.client, now: () => clock }),
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
    api,
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

test("overlapping polls start one run per incident, with the incident as its input", async () => {
  const h = engineHarness();
  await h.engine.arm();
  h.at(minutes(5));
  h.api.replies.push([incident("Q1", minutes(1)), incident("Q2", minutes(4))]);
  await h.engine.poll("pages");
  h.at(minutes(10));
  // The overlap hands both back again, next to one that is new.
  h.api.replies.push([
    incident("Q1", minutes(1)),
    incident("Q2", minutes(4)),
    incident("Q3", minutes(8)),
  ]);
  await h.engine.poll("pages");

  expect(h.starts).toEqual([
    { inputs: { team: "infra", incident: "Q1" }, triggerId: eventTriggerId("pages", "Q1") },
    { inputs: { team: "infra", incident: "Q2" }, triggerId: eventTriggerId("pages", "Q2") },
    { inputs: { team: "infra", incident: "Q3" }, triggerId: eventTriggerId("pages", "Q3") },
  ]);
  // The second poll reached back behind where the first one began.
  const since = h.api.urls
    .filter((url) => url.searchParams.get("offset") === "0")
    .map((url) => url.searchParams.get("since"));
  expect(since).toEqual([
    new Date(T0.getTime() - POLL_OVERLAP_MS).toISOString(),
    new Date(minutes(5).getTime() - POLL_OVERLAP_MS).toISOString(),
  ]);
});

test("an incident still triggered after its run ends does not start a second run", async () => {
  const h = engineHarness();
  await h.engine.arm();
  h.at(minutes(2));
  h.api.replies.push([incident("Q1", minutes(1))]);
  await h.engine.poll("pages");
  expect(h.starts).toHaveLength(1);

  for (const run of h.runs) run.status = "completed";
  for (const at of [minutes(3), minutes(4), minutes(60)]) {
    h.at(at);
    h.api.replies.push([incident("Q1", minutes(1))]);
    await h.engine.poll("pages");
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
  h.api.replies.push([incident("Q1", T0)]);
  await h.engine.poll("pages");
  expect(h.starts.map((start) => start.triggerId)).toEqual([eventTriggerId("pages", "Q1")]);
  expect(h.memory.state("pages", "Q1")?.occurredAt).toEqual(T0);
});

test("an incident acknowledged or resolved before the poll still starts exactly one run", async () => {
  const h = engineHarness();
  await h.engine.arm();
  h.at(minutes(5));
  h.api.replies.push([
    incident("Q1", minutes(1), "acknowledged"),
    incident("Q2", minutes(2), "resolved"),
  ]);
  await h.engine.poll("pages");
  h.at(minutes(10));
  h.api.replies.push([
    incident("Q1", minutes(1), "resolved"),
    incident("Q2", minutes(2), "resolved"),
  ]);
  await h.engine.poll("pages");
  await h.engine.drain();

  expect(h.starts.map((start) => start.triggerId)).toEqual([
    eventTriggerId("pages", "Q1"),
    eventTriggerId("pages", "Q2"),
  ]);
});

test("an incident created before the trigger was first enabled starts nothing", async () => {
  const h = engineHarness();
  await h.engine.arm();
  h.at(minutes(2));
  h.api.replies.push([incident("Q0", minutes(-1))]);
  await h.engine.poll("pages");
  expect(h.starts).toEqual([]);
  expect(h.memory.rows.size).toBe(0);
});

test("the source is shipped, and its trigger polls PagerDuty for doctor", async () => {
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

test("an incident pushed, then polled, starts exactly one run", async () => {
  const h = engineHarness();
  await h.engine.arm();
  h.at(minutes(2));

  expect(await h.engine.push("pagerduty", triggered())).toEqual(["pages"]);
  await h.engine.drain();
  h.api.replies.push([incident("Q1", minutes(1))]);
  await h.engine.poll("pages");
  expect(await h.engine.push("pagerduty", triggered())).toEqual([]);
  await h.engine.drain();

  expect(h.starts).toEqual([
    { inputs: { team: "infra", incident: "Q1" }, triggerId: eventTriggerId("pages", "Q1") },
  ]);
  expect(h.memory.state("pages", "Q1")?.occurredAt).toEqual(minutes(1));
});

test("a pushed incident on a service the trigger does not watch starts nothing", async () => {
  const h = engineHarness();
  await h.engine.arm();
  h.at(minutes(2));
  const elsewhere = withEvent({}, { service: { id: "PSVC009" } });
  expect(await h.engine.push("pagerduty", elsewhere)).toEqual([]);
  expect(h.memory.rows.size).toBe(0);
});
