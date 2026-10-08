import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SPEC_VERSION_CURRENT } from "@workflow/world";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { resumeHook } from "workflow/api";
import { HookNotFoundError } from "workflow/errors";
import { setWorld } from "workflow/runtime";
import { z } from "zod";
import * as sql from "../steps/runtime/registry.ts";
import { testFactoryContext } from "../test-fixtures.ts";
import { JIGS_VERSION, VERSION_HEADER } from "../version.ts";
import { type Factory, ticketInputSchema } from "../workflow/factory.ts";
import { linearListeningToken, linearSessionToken } from "../workflow/linear/agent-session.ts";
import { ticketToken } from "../workflow/linear/ticket-token.ts";
import { pullRequestToken } from "../workflow/pull-requests/pull-request.ts";
import * as queue from "./queue.ts";
import { appClient } from "./test-fixtures.ts";
import { clearWakes, lastWake } from "./wake.ts";

const ambientWorkflowEnv = vi.hoisted(() => {
  const targetWorld = process.env.WORKFLOW_TARGET_WORLD;
  delete process.env.WORKFLOW_TARGET_WORLD;
  return { targetWorld };
});

vi.stubEnv("WORKFLOW_TARGET_WORLD", undefined);

const { createApp } = await import("./app.ts");

// The factory every app here answers for: its secrets, and an empty registry
// rather than the operator's database.
const env: Record<string, string | undefined> = {};
const context = testFactoryContext({ slug: "factory-test", env });
const deps = { context, registry: () => ({}) as never };

// The routes are exercised against workflows this file declares: what is under
// test is the framework.
const fixture = {
  workflows: {
    plain: {
      workflow: async () => undefined,
      inputs: z.object({
        ticket: ticketInputSchema,
        askHuman: z.boolean().default(false),
      }),
    },
    dated: {
      workflow: async () => undefined,
      inputs: z.object({ when: z.date(), name: z.string() }),
    },
  },
} satisfies Factory;

const RUN = "wrun_01K3ANBZ4TQ8W9YV6H2E5C7DKM";

// A wake hands every accepted event to the SDK's own resumeHook, and
// what a delivery is worth is what that call answers — so the SDK is what a
// test stands in for here, never a seam of the app's.
vi.mock("workflow/api", async (importActual) => ({
  ...(await importActual<typeof import("workflow/api")>()),
  resumeHook: vi.fn(),
}));
const resumeHookMock = vi.mocked(resumeHook);
// The wake is noted for the run the resumed hook names.
const delivers = () => resumeHookMock.mockResolvedValueOnce({ runId: RUN } as never);

const app = appClient(createApp(fixture, deps));

// A second factory, because what the schedule routes answer is a property of
// the config handed in. Nothing ticks here: the ticker is started by the
// generated nitro plugin, not by the app.
const scheduled = {
  workflows: fixture.workflows,
  schedules: {
    "nightly-plain": {
      workflow: "plain",
      cron: "0 3 * * *",
      inputs: { ticket: "AGE-317" },
    },
    "broken-cron": { workflow: "plain", cron: "always", inputs: {} },
  },
} satisfies Factory;
const scheduledApp = appClient(createApp(scheduled, deps));

// The local world binds its data dir on first use, so one fresh dir serves
// the whole file; it starts empty — nobody holds any token here.
let dataDir: string;

beforeAll(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "jigs-app-test-"));
});
afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
  if (ambientWorkflowEnv.targetWorld === undefined) delete process.env.WORKFLOW_TARGET_WORLD;
  else process.env.WORKFLOW_TARGET_WORLD = ambientWorkflowEnv.targetWorld;
});

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.spyOn(sql, "listResources").mockResolvedValue([]);
  vi.spyOn(queue, "listRunDeadJobs").mockResolvedValue([]);
  vi.stubEnv("WORKFLOW_LOCAL_DATA_DIR", dataDir);
  vi.stubEnv("XDG_DATA_HOME", path.join(dataDir, "resources"));
  vi.stubEnv("WORKFLOW_TARGET_WORLD", undefined);
  resumeHookMock.mockReset().mockRejectedValue(new HookNotFoundError("unclaimed-test-token"));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  // Clears the cached world too, so the next getWorld() opens the local one
  // again from the data dir above.
  setWorld(undefined);
});

test("poke of an unknown run is a 404", async () => {
  const res = await app.request("/api/runs/wr_does_not_exist/poke", {
    method: "POST",
  });
  expect(res.status).toBe(404);
});

test("cancel of a run nobody holds is a 404", async () => {
  const res = await app.request("/api/runs/wrun_01ZZZZZZZZZZZZZZZZZZZZZZZZ/cancel", {
    method: "POST",
  });
  expect(res.status).toBe(404);
  expect(await res.json()).toEqual({ error: "not found" });
});

test.each([
  ["a prefix", RUN.slice(0, 13)],
  ["a bare prefix", RUN.slice(5, 13)],
  ["a ticket", "AGE-317"],
])("a run route answers 404 for %s, even when a run matches it", async (_label, ref) => {
  const lookups: string[] = [];
  setWorld({
    specVersion: SPEC_VERSION_CURRENT,
    runs: {
      get: async (runId: string) => {
        lookups.push(runId);
        return { runId: RUN, status: "running", createdAt: new Date() };
      },
      list: async () => ({ data: [{ runId: RUN }], hasMore: false, cursor: null }),
    },
    hooks: { list: async () => ({ data: [] }) },
  } as unknown as Parameters<typeof setWorld>[0]);

  const res = await app.request(`/api/runs/${ref}`);

  expect(res.status).toBe(404);
  expect(await res.json()).toEqual({ error: "not found" });
  expect(lookups).toEqual([]);
});

test("a workflow's inputs route answers with its JSON Schema", async () => {
  const res = await app.request("/api/workflows/plain/inputs");
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    name: string;
    inputs: { properties: Record<string, unknown>; required: string[] };
  };
  expect(body.name).toBe("plain");
  expect(body.inputs.properties.ticket).toBeDefined();
  expect(body.inputs.required).toEqual(["ticket"]);
  // io: "input" — the defaulted field must not be demanded of the caller.
  expect(body.inputs.required).not.toContain("askHuman");
});

test("a member zod cannot render leaves the route green and the member open", async () => {
  const res = await app.request("/api/workflows/dated/inputs");
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    inputs: { properties: Record<string, unknown> };
  };
  expect(body.inputs.properties.when).toEqual({});
  expect(body.inputs.properties.name).toEqual({ type: "string" });
});

test("an unknown workflow's inputs route is a 404 naming the known workflows", async () => {
  const res = await app.request("/api/workflows/nope/inputs");
  expect(res.status).toBe(404);
  const body = (await res.json()) as {
    error: string;
    knownWorkflows: string[];
  };
  expect(body.error).toBe("unknown workflow: nope");
  expect(body.knownWorkflows).toEqual(["plain", "dated"]);
});

test("workflow discovery returns actual launch names and their existing input metadata", async () => {
  const res = await app.request("/api/workflows");
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    workflows: Array<{ name: string; inputs: { properties: Record<string, unknown> } }>;
  };
  expect(body.workflows.map((workflow) => workflow.name)).toEqual(["plain", "dated"]);
  expect(body.workflows[0]?.inputs.properties.ticket).toBeDefined();
  expect(body.workflows[0]?.inputs.properties.askHuman).toMatchObject({
    type: "boolean",
    default: false,
  });
});

test("every response names the jigs the service runs, misses included", async () => {
  for (const res of [await app.request("/api/workflows"), await app.request("/api/nope")]) {
    expect(res.headers.get(VERSION_HEADER)).toBe(JIGS_VERSION);
  }
});

test("a miss and a crash answer plain text, never a stack", async () => {
  const miss = await app.request("/api/nope");
  expect(miss.status).toBe(404);
  expect(await miss.text()).toBe("404 Not Found");
  vi.spyOn(console, "error").mockImplementation(() => {});
  const crash = await appClient(
    createApp(fixture, {
      ...deps,
      registry: () => {
        throw new Error("registry down");
      },
    }),
  ).request("/api/runs");
  expect(crash.status).toBe(500);
  expect(await crash.text()).toBe("Internal Server Error");
});

test("health names the factory and the process that answer here, and the injected workflows", async () => {
  const res = await appClient(
    createApp(fixture, {
      ...deps,
      context: testFactoryContext({ root: "/factories/acme" }),
    }),
  ).request("/health");
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({
    ok: true,
    // No startService has run here, so the boot has not begun: live,
    // but not what `jigs up` waits for.
    ready: false,
    phase: "starting",
    factoryRoot: "/factories/acme",
    pid: process.pid,
    workflows: ["plain", "dated"],
  });
});

test("health outside a factory reports a null root rather than failing liveness", async () => {
  vi.stubEnv("JIGS_FACTORY_ROOT", "");
  const cwd = vi.spyOn(process, "cwd").mockReturnValue(dataDir);
  try {
    const res = await appClient(createApp(fixture)).request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, factoryRoot: null });
  } finally {
    cwd.mockRestore();
  }
});

test("GET /api/runs answers with empty runs when nothing has launched", async () => {
  const res = await app.request("/api/runs");
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ runs: [], schedules: [], triggers: [] });
});

test("GET /api/runs still answers with runs when the triggers cannot be read", async () => {
  // The registry the triggers live in is unusable here.
  const triggered = appClient(
    createApp(
      {
        ...fixture,
        triggers: { pages: { workflow: "run", source: { kind: "fake.pages", params: {} } } },
      },
      deps,
    ),
  );
  const res = await triggered.request("/api/runs");
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    runs: unknown[];
    triggers: unknown[];
    triggersError?: string;
  };
  expect(body).toMatchObject({ runs: [], schedules: [], triggers: [] });
  expect(body.triggersError).toEqual(expect.any(String));
});

test("GET /api/runs lists each run with the resources it recorded and their states", async () => {
  const at = new Date("2026-09-04T10:00:00.000Z");
  const row = (kind: string, state: "kept" | "live", reason: string | null) => ({
    factory: "factory-test",
    runId: RUN,
    kind,
    identity: `${kind}-1`,
    url: `https://example.test/${kind}`,
    state,
    reason,
    attempts: 0,
    repoDir: null,
    branch: null,
    createdAt: at,
    updatedAt: at,
  });
  vi.spyOn(sql, "listResources").mockResolvedValue([
    row("worktree", "kept", "uncommitted work kept"),
    row("pull-request", "live", null),
  ]);
  setWorld({
    specVersion: SPEC_VERSION_CURRENT,
    runs: {
      list: async () => ({
        data: [
          { runId: RUN, status: "failed", workflowName: "wf", createdAt: at, completedAt: at },
        ],
        hasMore: false,
      }),
    },
    hooks: { list: async () => ({ data: [], hasMore: false }) },
    steps: { list: async () => ({ data: [], hasMore: false }) },
  } as unknown as Parameters<typeof setWorld>[0]);

  const body = (await (await app.request("/api/runs")).json()) as {
    runs: Array<{ runId: string; status: string; resources: unknown[] }>;
  };

  expect(body.runs).toMatchObject([
    {
      runId: RUN,
      status: "failed",
      resources: [
        { kind: "worktree", state: "kept", reason: "uncommitted work kept" },
        { kind: "pull-request", state: "live", reason: null },
      ],
    },
  ]);
});

test("GET /api/runs/:runId/steps answers with the run's steps and its dead jobs", async () => {
  setWorld({
    specVersion: SPEC_VERSION_CURRENT,
    runs: { get: async () => ({}) },
    steps: {
      list: async () => ({
        data: [
          {
            stepName: "step//./steps/jigs//worktree",
            status: "failed",
            attempt: 3,
            createdAt: new Date("2026-09-04T10:00:00.000Z"),
            startedAt: new Date("2026-09-04T10:00:00.000Z"),
            completedAt: new Date("2026-09-04T10:00:04.000Z"),
            error: { message: "binding api has no clone" },
          },
        ],
      }),
    },
  } as unknown as Parameters<typeof setWorld>[0]);

  const res = await app.request(`/api/runs/${RUN}/steps`);

  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    steps: [
      {
        name: "step//./steps/jigs//worktree",
        status: "failed",
        attempt: 3,
        startedAt: "2026-09-04T10:00:00.000Z",
        completedAt: "2026-09-04T10:00:04.000Z",
        error: "binding api has no clone",
      },
    ],
    deadJobs: [],
  });
});

test("a steps request for a run nobody launched is a 404", async () => {
  const res = await app.request(`/api/runs/${RUN}/steps`);
  expect(res.status).toBe(404);
});

test("GET /api/runs/:runId reports the run's resources and claim from its state read", async () => {
  const row = {
    factory: "factory-test",
    runId: RUN,
    kind: "pull-request",
    identity: "acme/api#41",
    url: "https://github.com/acme/api/pull/41",
    state: "live" as const,
    reason: null,
    attempts: 0,
    repoDir: null,
    branch: null,
    createdAt: new Date("2026-09-04T10:00:00.000Z"),
    updatedAt: new Date("2026-09-04T10:00:00.000Z"),
  };
  const listed = vi.spyOn(sql, "listResources").mockResolvedValue([row]);
  const claim = ticketToken("acme", "68bc9696-35d5-442d-ab56-214c8cfefbec");
  setWorld({
    specVersion: SPEC_VERSION_CURRENT,
    runs: {
      get: async () => ({
        runId: RUN,
        status: "running",
        workflowName: "wf",
        createdAt: new Date(),
      }),
    },
    steps: { list: async () => ({ data: [] }) },
    hooks: { list: async () => ({ data: [{ runId: RUN, token: claim }] }) },
  } as unknown as Parameters<typeof setWorld>[0]);

  const res = await app.request(`/api/runs/${RUN}`);
  const body = (await res.json()) as { resources: unknown; claim: unknown };

  expect(res.status).toBe(200);
  expect(listed).toHaveBeenCalledWith({}, { factory: "factory-test", runId: RUN });
  expect(body.claim).toBe(claim);
  expect(body.resources).toEqual([
    {
      runId: RUN,
      kind: "pull-request",
      identity: "acme/api#41",
      url: "https://github.com/acme/api/pull/41",
      state: "live",
      reason: null,
      updatedAt: "2026-09-04T10:00:00.000Z",
    },
  ]);
});

const CLAIM = ticketToken("acme", "68bc9696-35d5-442d-ab56-214c8cfefbec");
const SESSION = linearSessionToken("acme", "session-1");
const LISTENING = linearListeningToken("acme", "session-1");
const PR = pullRequestToken({ installationName: "acme", owner: "acme", repo: "api", number: 41 });

// A running run holding exactly these hooks. The routes below read no other
// world surface, so anything they touch beyond `hooks.list` rejects and is
// reported rather than thrown.
const runHolding = (...tokens: string[]) =>
  (() => {
    let status = "running";
    let held = [...tokens];
    return setWorld({
      specVersion: SPEC_VERSION_CURRENT,
      runs: { get: async () => ({ status, createdAt: new Date() }) },
      steps: { list: async () => ({ data: [] }) },
      hooks: { list: async () => ({ data: held.map((token) => ({ token })) }) },
      events: {
        create: async () => {
          status = "cancelled";
          held = [];
        },
      },
    } as unknown as Parameters<typeof setWorld>[0]);
  })();

test("GET /api/runs/:runId says what each park is waiting for, and where to act", async () => {
  runHolding(CLAIM, SESSION, LISTENING, PR);

  const res = await app.request(`/api/runs/${RUN}`);

  expect(res.status).toBe(200);
  // The claim and the session's ownership hook are held for the run's whole
  // life, so neither is a suspension; the other two explain themselves.
  expect(await res.json()).toMatchObject({
    status: "running",
    suspensions: [
      {
        token: LISTENING,
        kind: "linear-listening",
        reason: "waiting for a reply in Linear agent session session-1",
      },
      {
        token: PR,
        kind: "pull-request",
        reason: "waiting for pull request activity on acme/api#41",
        url: "https://github.com/acme/api/pull/41",
      },
    ],
  });
});

test("a run holding only its ticket claim is not parked", async () => {
  runHolding(CLAIM);

  const res = await app.request(`/api/runs/${RUN}`);

  expect(await res.json()).toMatchObject({
    status: "running",
    suspensions: [],
    trigger: "manual",
  });
});

test("poke wakes what the run waits on, never a lock it holds", async () => {
  runHolding(CLAIM, SESSION, LISTENING);

  const res = await app.request(`/api/runs/${RUN}/poke`, { method: "POST" });

  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ poked: [{ token: LISTENING }] });
});

test("a run holding only its ticket claim has nothing to poke", async () => {
  runHolding(CLAIM);

  const res = await app.request(`/api/runs/${RUN}/poke`, { method: "POST" });

  expect(res.status).toBe(409);
});

test("a poke that landed is the wake the run's status reports", async () => {
  clearWakes();
  runHolding(PR);
  delivers();

  await app.request(`/api/runs/${RUN}/poke`, { method: "POST" });

  expect(lastWake(PR, RUN)?.kind).toBe("poke");
});

test("a poke the World cannot deliver says so instead of calling the wait gone", async () => {
  runHolding(PR);
  resumeHookMock.mockRejectedValueOnce(new Error("database unavailable"));

  const res = await app.request(`/api/runs/${RUN}/poke`, { method: "POST" });

  expect(await res.json()).toEqual({
    runId: RUN,
    poked: [{ token: PR, outcome: "failed", error: "Error: database unavailable" }],
  });
});

test("a poke whose hook is gone reports it gone", async () => {
  runHolding(PR);

  const res = await app.request(`/api/runs/${RUN}/poke`, { method: "POST" });

  expect(await res.json()).toEqual({ runId: RUN, poked: [{ token: PR, outcome: "gone" }] });
});

test("cancel reports observed hook release, retained worktrees, and no queue-deletion count", async () => {
  runHolding(CLAIM, LISTENING);

  const res = await app.request(`/api/runs/${RUN}/cancel`, { method: "POST" });

  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    runId: RUN,
    cancelled: true,
    releasedTokens: [CLAIM, LISTENING],
    retainedTokens: [],
    worktrees: [],
  });
});

test("cancel reports a hook the World retains", async () => {
  setWorld({
    specVersion: SPEC_VERSION_CURRENT,
    runs: { get: async () => ({ status: "running", createdAt: new Date() }) },
    hooks: { list: async () => ({ data: [{ token: CLAIM }] }) },
    events: { create: async () => undefined },
  } as unknown as Parameters<typeof setWorld>[0]);

  const res = await app.request(`/api/runs/${RUN}/cancel`, { method: "POST" });

  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ releasedTokens: [], retainedTokens: [CLAIM] });
});

test("GET /api/schedules answers with what the factory declared, and what is next", async () => {
  const res = await scheduledApp.request("/api/schedules");
  expect(res.status).toBe(200);
  const body = (await res.json()) as Array<{
    name: string;
    workflow: string;
    cron: string;
    next: string | null;
    active: string | null;
  }>;
  expect(body.map((s) => s.name)).toEqual(["nightly-plain", "broken-cron"]);
  expect(body[0]).toMatchObject({
    name: "nightly-plain",
    workflow: "plain",
    cron: "0 3 * * *",
    active: null,
  });
  expect(new Date(body[0]?.next ?? "").getTime()).toBeGreaterThan(Date.now());
  // Declared but unschedulable: it is still reported, with nothing to come.
  expect(body[1]).toMatchObject({ name: "broken-cron", next: null });
});

test("a factory with no schedules answers an empty listing", async () => {
  const res = await app.request("/api/schedules");
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual([]);
});
