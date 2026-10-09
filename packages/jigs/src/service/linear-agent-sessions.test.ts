import { readFileSync } from "node:fs";
import { beforeEach, expect, test, vi } from "vitest";
import { z } from "zod";
import { HubResponseError } from "../providers/hub.ts";
import type { LinearIssueFiling } from "../providers/linear.ts";
import * as linearApi from "../providers/linear.ts";
import type { Factory } from "../workflow/factory.ts";
import { type LinearAgentSessionsParams, linear } from "../workflow/linear/source.ts";
import { createTriggerEngine } from "./event-triggers/engine.ts";
import type { PreparedRun } from "./launch.ts";
import { LINEAR_AGENT_SESSIONS as source } from "./linear-agent-sessions.ts";
import { eventTriggerId } from "./runs.ts";
import { memoryTriggerStore } from "./test-fixtures.ts";

type Payload = Record<string, unknown> & { agentSession: Record<string, unknown> };

const created = (): Payload =>
  JSON.parse(
    readFileSync(new URL("./fixtures/linear-agent-session-created.json", import.meta.url), "utf8"),
  );
const withSession = (fields: Record<string, unknown>, session: Record<string, unknown> = {}) => {
  const payload = created();
  return { ...payload, ...fields, agentSession: { ...payload.agentSession, ...session } };
};

const SESSION = "9b7e5c3a-1d2f-4e6a-8b0c-2d4f6a8c0e1b";
const ISSUE = "1e2d3c4b-5a69-4788-9a0b-1c2d3e4f5a6b";

const ACME = { installationName: "acme" };
const from = (payload: unknown, installationName = "acme") => ({ installationName, payload });

type IssueFiling = (issueId: string, installationName: string) => Promise<LinearIssueFiling | null>;

// The issue's filing, as the source reads it through a Linear client for the trigger's installation.
function stubFiling<F extends IssueFiling>(issueFiling: F): F {
  vi.spyOn(linearApi, "linearFor").mockImplementation(
    (installationName) =>
      ({
        fetchIssueFiling: (issueId: string) => issueFiling(issueId, installationName),
      }) as unknown as linearApi.LinearClient,
  );
  return issueFiling;
}
const filed = (filing: LinearIssueFiling) => stubFiling(vi.fn(async () => filing));
const unread = () =>
  stubFiling(
    vi.fn(async (): Promise<LinearIssueFiling> => {
      throw new Error("the issue was read");
    }),
  );

beforeEach(() => {
  vi.restoreAllMocks();
  unread();
});

test("a mention starts a run with the session, its issue, the comment and who asked", async () => {
  const pushed = await source.fromPush(ACME, from(created()));

  expect(pushed).toEqual({
    key: SESSION,
    inputs: {
      session: SESSION,
      installationName: "acme",
      issue: {
        id: ISSUE,
        identifier: "ENG-42",
        title: "Checkout button does nothing on Safari",
        url: "https://linear.app/acme/issue/ENG-42/checkout-button-does-nothing-on-safari",
      },
      comment: "@jigs can you fix this?",
      promptContext:
        '<issue identifier="ENG-42">\n<title>Checkout button does nothing on Safari</title>\n</issue>',
      creator: {
        id: "7a6b5c4d-3e2f-4a1b-9c8d-7e6f5a4b3c2d",
        name: "Ada Lovelace",
        email: "ada@example.com",
      },
    },
    at: new Date("2026-10-04T12:00:00.123Z"),
  });
  expect(source.describe(pushed?.inputs ?? {})).toBe(`linear ENG-42 session ${SESSION}`);
});

test("an assignment starts a run with no comment", async () => {
  const assigned = withSession({}, { comment: null, commentId: null });
  expect((await source.fromPush(ACME, from(assigned)))?.inputs).toMatchObject({
    session: SESSION,
    comment: null,
  });
});

test("a session the app opened itself, with no creator, starts no run", async () => {
  expect(
    await source.fromPush(ACME, from(withSession({}, { creator: null, creatorId: null }))),
  ).toBeNull();
  expect(
    await source.fromPush(ACME, from(withSession({}, { creator: undefined, creatorId: null }))),
  ).toBeNull();
});

test("a prompt context missing or of an unexpected shape still starts a run, without it", async () => {
  for (const promptContext of [undefined, { issue: "ENG-42" }]) {
    const pushed = await source.fromPush(ACME, from(withSession({ promptContext })));
    expect(pushed?.inputs).toMatchObject({ promptContext: null });
  }
});

test("the same session keys the same occurrence however often it arrives", async () => {
  const first = await source.fromPush(ACME, from(created()));
  const again = await source.fromPush(ACME, from(withSession({ webhookTimestamp: 1791115260000 })));
  expect(again?.key).toBe(first?.key);
});

test("only a created session on an issue is an occurrence", async () => {
  for (const action of ["prompted", "updated"])
    expect(await source.fromPush(ACME, from(withSession({ action })))).toBeNull();
  expect(await source.fromPush(ACME, from(withSession({ type: "Comment" })))).toBeNull();
  expect(
    await source.fromPush(ACME, from(withSession({}, { issue: null, issueId: null }))),
  ).toBeNull();
  expect(await source.fromPush(ACME, from(null))).toBeNull();
  expect(
    await source.fromPush(ACME, from({ type: "Issue", action: "create", data: {} })),
  ).toBeNull();
});

test("a created session without an id is ignored loudly, not retried", async () => {
  const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
  expect(await source.fromPush(ACME, from(withSession({}, { id: undefined })))).toBeNull();
  expect(errors).toHaveBeenCalledWith(
    expect.stringContaining("[linear] ignored an agent session event it could not read"),
  );
  errors.mockRestore();
});

test("teams match the issue's team key or id without reading the issue", async () => {
  expect(await source.fromPush({ ...ACME, teams: ["OPS", "ENG"] }, from(created()))).not.toBeNull();
  expect(
    await source.fromPush(
      { ...ACME, teams: ["c0ffee00-1111-4222-8333-444455556666"] },
      from(created()),
    ),
  ).not.toBeNull();
  expect(await source.fromPush({ ...ACME, teams: ["OPS"] }, from(created()))).toBeNull();
});

test("projects and labels match what the issue is filed under, read in the trigger's installation", async () => {
  const issueFiling = filed({
    project: { id: "d1e2f3a4-0000-4000-8000-000000000001", slugId: "8f2c1a9b7e3d" },
    labels: ["Bug", "agent"],
  });
  const push = (params: Omit<LinearAgentSessionsParams, "installationName">) =>
    source.fromPush({ ...ACME, ...params }, from(created()));

  expect(await push({ projects: ["8f2c1a9b7e3d"] })).not.toBeNull();
  expect(await push({ projects: ["d1e2f3a4-0000-4000-8000-000000000001"] })).not.toBeNull();
  expect(await push({ projects: ["other"] })).toBeNull();
  expect(await push({ labels: ["agent"] })).not.toBeNull();
  expect(await push({ labels: ["Feature"] })).toBeNull();
  expect(await push({ projects: ["8f2c1a9b7e3d"], labels: ["Feature"] })).toBeNull();
  expect(await push({ teams: ["OPS"], labels: ["agent"] })).toBeNull();
  expect(issueFiling).toHaveBeenCalledWith(ISSUE, "acme");
});

test("an issue in no project never matches a project filter", async () => {
  filed({ project: null, labels: [] });
  expect(
    await source.fromPush({ ...ACME, projects: ["8f2c1a9b7e3d"] }, from(created())),
  ).toBeNull();
});

test("an issue the app cannot read is ignored loudly", async () => {
  const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
  stubFiling(vi.fn(async () => null));
  expect(await source.fromPush({ ...ACME, labels: ["agent"] }, from(created()))).toBeNull();
  expect(errors.mock.calls.map(([line]) => String(line))).toEqual([
    expect.stringContaining("which the app cannot read"),
  ]);
  errors.mockRestore();
});

test("a hub that cannot answer for the installation fails the push, to be retried", async () => {
  stubFiling(
    vi.fn(async () => {
      throw new HubResponseError(503, "unavailable");
    }),
  );
  await expect(source.fromPush({ ...ACME, labels: ["agent"] }, from(created()))).rejects.toThrow(
    "unavailable",
  );
});

test("an installation name is required, and empty filter lists are refused", () => {
  expect(source.params.safeParse({}).success).toBe(false);
  expect(source.params.safeParse({ ...ACME, teams: [] }).success).toBe(false);
  expect(source.params.safeParse({ ...ACME, team: ["ENG"] }).success).toBe(false);
  expect(linear.agentSessions({ ...ACME, labels: ["agent"] })).toEqual({
    kind: "linear.agentSessions",
    params: { installationName: "acme", labels: ["agent"] },
  });
});

test("a session from another installation is not this trigger's", async () => {
  expect(await source.fromPush(ACME, from(created(), "other"))).toBeNull();
});

function sessionEngine(params: Omit<LinearAgentSessionsParams, "installationName"> = {}) {
  const T0 = new Date("2026-10-04T11:59:00.000Z");
  const memory = memoryTriggerStore(() => T0, T0);
  const starts: Array<{ inputs: unknown; triggerId: string }> = [];
  const factory: Factory = {
    workflows: {
      answer: {
        workflow: async () => undefined,
        inputs: z.object({ session: z.string(), issue: z.object({ identifier: z.string() }) }),
      },
    },
    triggers: {
      mentions: {
        active: true,
        workflow: "answer",
        source: linear.agentSessions({ ...ACME, ...params }),
      },
    },
  };
  const engine = createTriggerEngine(factory, {
    store: memory.store,
    now: () => T0,
    log: () => {},
    factorySlug: () => "factory-a",
    runStatuses: async () => new Map(),
    findRunsByAttribute: async () => [],
    liveRunsByAttribute: async () => new Map(),
    cancelRun: async () => {},
    prepareRun: async (_factory, _workflow, inputs): Promise<PreparedRun> => ({
      kind: "ready",
      launch: async (triggerId) => {
        starts.push({ inputs, triggerId });
        return `wrun_${starts.length}`;
      },
    }),
  });
  return { engine, starts };
}

test("a session the hub delivers twice starts one run", async () => {
  const { engine, starts } = sessionEngine();
  await engine.arm();

  expect(await engine.push("linear", from(created()))).toEqual(["mentions"]);
  expect(await engine.push("linear", from(created()))).toEqual([]);
  await engine.drain();

  expect(starts).toHaveLength(1);
  expect(starts[0]?.triggerId).toBe(eventTriggerId("mentions", SESSION));
});

test("a filter that cannot read the issue fails the push rather than passing the session over", async () => {
  const { engine, starts } = sessionEngine({ labels: ["agent"] });
  await engine.arm();
  await expect(engine.push("linear", from(created()))).rejects.toThrow("could not read the event");
  expect(starts).toEqual([]);
});

test("an installation the hub does not give the factory passes the session over, not retried", async () => {
  stubFiling(
    vi.fn(async () => {
      throw new HubResponseError(404, "no such installation");
    }),
  );
  const { engine, starts } = sessionEngine({ labels: ["agent"] });
  await engine.arm();
  expect(await engine.push("linear", from(created()))).toEqual([]);
  expect(starts).toEqual([]);
});

test("an event of another type is passed over without reading the issue", async () => {
  const filing = unread();
  const { engine } = sessionEngine({ labels: ["agent"] });
  await engine.arm();
  const prompted = { ...created(), action: "prompted" };
  const comment = { type: "Comment", action: "create", data: { id: "c1" } };
  expect(await engine.push("linear", from(prompted))).toEqual([]);
  expect(await engine.push("linear", from(comment))).toEqual([]);
  expect(filing).not.toHaveBeenCalled();
});
