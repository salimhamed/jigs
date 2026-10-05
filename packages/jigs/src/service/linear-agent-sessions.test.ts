import { readFileSync } from "node:fs";
import { expect, test, vi } from "vitest";
import { z } from "zod";
import { HubResponseError } from "../providers/hub.ts";
import type { LinearIssueFiling } from "../providers/linear.ts";
import type { Factory } from "../workflow/factory.ts";
import { linear } from "../workflow/linear/source.ts";
import { createTriggerEngine } from "./event-triggers/engine.ts";
import type { PreparedRun } from "./launch.ts";
import { type LinearAgentSessionsDeps, linearAgentSessions } from "./linear-agent-sessions.ts";
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
const WORKSPACE = "5c1d9e0b-7d0a-4c61-9a3e-2f6f1b8d4a10";
const ISSUE = "1e2d3c4b-5a69-4788-9a0b-1c2d3e4f5a6b";

const filed = (filing: LinearIssueFiling) => vi.fn(async () => filing);
const unread = () =>
  vi.fn(async (): Promise<LinearIssueFiling> => {
    throw new Error("the issue was read");
  });

test("a mention starts a run with the session, its issue, the comment and who asked", async () => {
  const source = linearAgentSessions({ issueFiling: unread() });

  const pushed = await source.fromPush({}, created());

  expect(pushed).toEqual({
    inputs: {
      session: SESSION,
      workspace: WORKSPACE,
      issue: {
        id: ISSUE,
        identifier: "ENG-42",
        title: "Checkout button does nothing on Safari",
        url: "https://linear.app/acme/issue/ENG-42/checkout-button-does-nothing-on-safari",
      },
      comment: "@jigs can you fix this?",
      creator: {
        id: "7a6b5c4d-3e2f-4a1b-9c8d-7e6f5a4b3c2d",
        name: "Ada Lovelace",
        email: "ada@example.com",
      },
    },
    at: new Date("2026-10-04T12:00:00.123Z"),
  });
  expect(source.occurrence(pushed?.inputs ?? {})).toBe(SESSION);
  expect(source.describe(pushed?.inputs ?? {})).toBe(`linear ENG-42 session ${SESSION}`);
});

test("an assignment starts a run with no comment, and an automation's with no creator", async () => {
  const source = linearAgentSessions({ issueFiling: unread() });
  const assigned = withSession({}, { comment: null, commentId: null });
  expect((await source.fromPush({}, assigned))?.inputs).toMatchObject({
    session: SESSION,
    comment: null,
  });
  const automated = withSession({}, { creator: null, creatorId: null });
  expect((await source.fromPush({}, automated))?.inputs).toMatchObject({ creator: null });
});

test("the same session keys the same occurrence however often it arrives", async () => {
  const source = linearAgentSessions({ issueFiling: unread() });
  const first = await source.fromPush({}, created());
  const again = await source.fromPush({}, withSession({ webhookTimestamp: 1791115260000 }));
  expect(source.occurrence(again?.inputs ?? {})).toBe(source.occurrence(first?.inputs ?? {}));
});

test("only a created session on an issue is an occurrence", async () => {
  const source = linearAgentSessions({ issueFiling: unread() });
  for (const action of ["prompted", "updated"])
    expect(await source.fromPush({}, withSession({ action }))).toBeNull();
  expect(await source.fromPush({}, withSession({ type: "Comment" }))).toBeNull();
  expect(await source.fromPush({}, withSession({}, { issue: null, issueId: null }))).toBeNull();
  expect(await source.fromPush({}, null)).toBeNull();
  expect(await source.fromPush({}, { type: "Issue", action: "create", data: {} })).toBeNull();
});

test("a created session without an id is ignored loudly, not retried", async () => {
  const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const source = linearAgentSessions({ issueFiling: unread() });
  expect(await source.fromPush({}, withSession({}, { id: undefined }))).toBeNull();
  expect(errors).toHaveBeenCalledWith(
    expect.stringContaining("[linear] ignored an agent session event it could not read"),
  );
  errors.mockRestore();
});

test("teams match the issue's team key or id without reading the issue", async () => {
  const source = linearAgentSessions({ issueFiling: unread() });
  expect(await source.fromPush({ teams: ["OPS", "ENG"] }, created())).not.toBeNull();
  expect(
    await source.fromPush({ teams: ["c0ffee00-1111-4222-8333-444455556666"] }, created()),
  ).not.toBeNull();
  expect(await source.fromPush({ teams: ["OPS"] }, created())).toBeNull();
});

test("projects and labels match what the issue is filed under, read in the session's workspace", async () => {
  const issueFiling = filed({
    project: { id: "d1e2f3a4-0000-4000-8000-000000000001", slugId: "8f2c1a9b7e3d" },
    labels: ["Bug", "agent"],
  });
  const source = linearAgentSessions({ issueFiling });
  const push = (params: Parameters<typeof source.fromPush>[0]) =>
    source.fromPush(params, created());

  expect(await push({ projects: ["8f2c1a9b7e3d"] })).not.toBeNull();
  expect(await push({ projects: ["d1e2f3a4-0000-4000-8000-000000000001"] })).not.toBeNull();
  expect(await push({ projects: ["other"] })).toBeNull();
  expect(await push({ labels: ["agent"] })).not.toBeNull();
  expect(await push({ labels: ["Feature"] })).toBeNull();
  expect(await push({ projects: ["8f2c1a9b7e3d"], labels: ["Feature"] })).toBeNull();
  expect(await push({ teams: ["OPS"], labels: ["agent"] })).toBeNull();
  expect(issueFiling).toHaveBeenCalledWith(ISSUE, WORKSPACE);
});

test("an issue in no project never matches a project filter", async () => {
  const source = linearAgentSessions({ issueFiling: filed({ project: null, labels: [] }) });
  expect(await source.fromPush({ projects: ["8f2c1a9b7e3d"] }, created())).toBeNull();
});

test("an issue the app cannot read, or a workspace the hub has no app for, is ignored loudly", async () => {
  const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const gone = linearAgentSessions({ issueFiling: vi.fn(async () => null) });
  expect(await gone.fromPush({ labels: ["agent"] }, created())).toBeNull();
  const unassigned = linearAgentSessions({
    issueFiling: vi.fn(async () => {
      throw new HubResponseError(404, "no Linear app in this workspace");
    }),
  });
  expect(await unassigned.fromPush({ labels: ["agent"] }, created())).toBeNull();
  expect(errors.mock.calls.map(([line]) => String(line))).toEqual([
    expect.stringContaining("which the app cannot read"),
    expect.stringContaining("which the hub has no app for"),
  ]);
  errors.mockRestore();
});

test("a hub that cannot answer for the workspace fails the push, to be retried", async () => {
  const source = linearAgentSessions({
    issueFiling: vi.fn(async () => {
      throw new HubResponseError(503, "unavailable");
    }),
  });
  await expect(source.fromPush({ labels: ["agent"] }, created())).rejects.toThrow("unavailable");
});

test("empty filter lists are refused", () => {
  const source = linearAgentSessions();
  expect(source.params.safeParse({ teams: [] }).success).toBe(false);
  expect(source.params.safeParse({ team: ["ENG"] }).success).toBe(false);
  expect(linear.agentSessions({ labels: ["agent"] })).toEqual({
    kind: "linear.agentSessions",
    params: { labels: ["agent"] },
  });
});

function sessionEngine(issueFiling: LinearAgentSessionsDeps["issueFiling"], params = {}) {
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
    triggers: { mentions: { workflow: "answer", source: linear.agentSessions(params) } },
  };
  const engine = createTriggerEngine(factory, {
    store: memory.store,
    sources: { "linear.agentSessions": linearAgentSessions({ issueFiling }) },
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
  const { engine, starts } = sessionEngine(unread());
  await engine.arm();

  expect(await engine.push("linear", created())).toEqual(["mentions"]);
  expect(await engine.push("linear", created())).toEqual([]);
  await engine.drain();

  expect(starts).toHaveLength(1);
  expect(starts[0]?.triggerId).toBe(eventTriggerId("mentions", SESSION));
});

test("a filter that cannot read the issue fails the push rather than passing the session over", async () => {
  const { engine, starts } = sessionEngine(unread(), { labels: ["agent"] });
  await engine.arm();
  await expect(engine.push("linear", created())).rejects.toThrow("could not read the event");
  expect(starts).toEqual([]);
});
