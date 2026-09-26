import { SPEC_VERSION_CURRENT } from "@workflow/world";
import { afterAll, afterEach, beforeEach, expect, test, vi } from "vitest";
import { HookNotFoundError, WorkflowRunNotFoundError } from "workflow/errors";
import { setWorld } from "workflow/runtime";
import { z } from "zod";
import * as config from "../config/factory-config.ts";
import * as root from "../config/factory-root.ts";
import * as github from "../providers/github.ts";
import { describeSuspension, type RunSuspension } from "../run-suspension.ts";
import * as sql from "../steps/runtime/registry.ts";
import { describeRunState } from "../steps/runtime/run-state.ts";
import type { Factory } from "../workflow/factory.ts";
import { ticketToken } from "../workflow/linear/claim.ts";
import { pullRequestToken } from "../workflow/pull-requests/pull-request.ts";
import {
  enrichSuspensions,
  listRuns,
  runExists,
  scheduleTriggerId,
  type WorldRun,
} from "./runs.ts";
import type * as stalls from "./stalls.ts";
import { clearWakes, recordWake } from "./wake-note.ts";

const ambientWorkflowEnv = vi.hoisted(() => {
  const targetWorld = process.env.WORKFLOW_TARGET_WORLD;
  const postgresUrl = process.env.WORKFLOW_POSTGRES_URL;
  delete process.env.WORKFLOW_TARGET_WORLD;
  delete process.env.WORKFLOW_POSTGRES_URL;
  return { targetWorld, postgresUrl };
});

afterAll(() => {
  if (ambientWorkflowEnv.targetWorld === undefined) delete process.env.WORKFLOW_TARGET_WORLD;
  else process.env.WORKFLOW_TARGET_WORLD = ambientWorkflowEnv.targetWorld;
  if (ambientWorkflowEnv.postgresUrl === undefined) delete process.env.WORKFLOW_POSTGRES_URL;
  else process.env.WORKFLOW_POSTGRES_URL = ambientWorkflowEnv.postgresUrl;
});

const RUN_A = "wrun_01K3ANBZ4TQ8W9YV6H2E5C7DKM";
const RUN_B = "wrun_01K3ANC1P0R4S6TXZ8B3F5G7HJ";

// Everything here is read off the world the SDK hands jigs, so the world is
// what a test stands up — the same seam app.test.ts uses.
beforeEach(() => {
  clearWakes();
  vi.spyOn(sql, "registrySql").mockReturnValue({} as never);
  vi.spyOn(sql, "currentFactory").mockReturnValue("factory-test");
  vi.spyOn(sql, "listResources").mockResolvedValue([]);
  world();
});

const prSnapshot = (
  patch: Partial<Omit<github.PullRequestSnapshot, "approval">> = {},
): Omit<github.PullRequestSnapshot, "approval"> => ({
  state: "open",
  merged: false,
  draft: false,
  headSha: "1234567890abcdef",
  mergeState: "clean",
  labels: [],
  mergeCommitSha: null,
  reviews: [
    {
      id: 1,
      state: "APPROVED",
      body: "",
      user: "reviewer",
      submittedAt: "2026-09-16T10:00:00Z",
      commitSha: "1234567890abcdef",
    },
  ],
  reviewThreads: [],
  conversationComments: [],
  ci: "green",
  failingChecks: [],
  ...patch,
});

// The factory's approval signal decides what "approved" means, so the
// enrichment reads the same config the merge gate does.
function reviewApproval(): void {
  vi.spyOn(root, "factoryRoot").mockReturnValue("/factory");
  vi.spyOn(config, "readFactoryConfig").mockReturnValue({
    bindings: {},
    service: { port: 8990, dashboardPort: 9090, pollIntervalSeconds: { github: 300, linear: 300 } },
    github: {
      identities: [
        { mode: "app", appId: 1, installations: { acme: 2 }, privateKeyPath: "k", operator: "me" },
      ],
      mergeApproval: "review",
    },
    linear: { identity: { mode: "key" } },
    agents: { env: [] },
  });
}

function parkedOnPr(): RunSuspension {
  const suspension = describeSuspension(PARK_TOKEN);
  if (suspension === null) throw new Error("expected a pull-request suspension");
  return suspension;
}

test.each([
  ["green and approved", {}, "nothing — it can merge", "approved"],
  ["CI red", { ci: "red" as const }, "CI is red", "approved"],
  ["branch conflicting", { mergeState: "dirty" }, "the branch conflicts with its base", "approved"],
  ["draft", { draft: true }, "the pull request is a draft", "approved"],
  ["no approving review", { reviews: [] }, "no approving review yet", "none"],
])("pull-request enrichment reports %s", async (_case, patch, blocker, approval) => {
  reviewApproval();
  vi.spyOn(github, "fetchPrSnapshot").mockResolvedValue(prSnapshot(patch));
  expect((await enrichSuspensions([parkedOnPr()], RUN_A))[0]).toMatchObject({
    headSha: "1234567",
    ci: prSnapshot(patch).ci,
    approval,
    draft: prSnapshot(patch).draft,
    mergeState: prSnapshot(patch).mergeState,
    blocker,
  });
  expect(github.fetchPrSnapshot).toHaveBeenCalledExactlyOnceWith({
    owner: "acme",
    repo: "api",
    number: 41,
  });
});

test("a run reads the wake it was sent, and never another run's", async () => {
  reviewApproval();
  vi.spyOn(github, "fetchPrSnapshot").mockResolvedValue(prSnapshot());
  recordWake(PARK_TOKEN, RUN_B, "github check_suite", new Date("2026-09-16T10:05:00Z"));
  expect((await enrichSuspensions([parkedOnPr()], RUN_A))[0]?.lastWake).toBeUndefined();

  recordWake(PARK_TOKEN, RUN_A, "nudge sweep", new Date("2026-09-16T10:06:00Z"));
  expect((await enrichSuspensions([parkedOnPr()], RUN_A))[0]?.lastWake).toEqual({
    kind: "nudge sweep",
    at: "2026-09-16T10:06:00.000Z",
  });
});

test("a failed GitHub enrichment returns the original suspension", async () => {
  reviewApproval();
  vi.spyOn(github, "fetchPrSnapshot").mockRejectedValue(new Error("GitHub unavailable"));
  const original = parkedOnPr();
  expect(await enrichSuspensions([original], RUN_A)).toEqual([original]);
});

afterEach(() => {
  vi.restoreAllMocks();
  setWorld(undefined);
});

interface StoredRun extends WorldRun {
  input?: unknown;
}

interface StoredStep {
  stepName: string;
  status: string;
  attempt: number;
  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;
}

interface Fixture {
  runs?: StoredRun[];
  runPages?: StoredRun[][];
  hooks?: Array<{ runId: string; token: string }>;
  steps?: Record<string, StoredStep[]>;
}

function world(fixture: Fixture = {}): void {
  const runs = fixture.runs ?? [];
  const runPages = fixture.runPages ?? [runs];
  const hooks = fixture.hooks ?? [];
  const steps = fixture.steps ?? {};
  setWorld({
    specVersion: SPEC_VERSION_CURRENT,
    steps: {
      list: async ({ runId }: { runId: string }) => ({ data: steps[runId] ?? [] }),
    },
    runs: {
      get: async (runId: string) => {
        const run = runs.find((candidate) => candidate.runId === runId);
        if (run === undefined) throw new WorkflowRunNotFoundError(runId);
        return run;
      },
      list: async ({ pagination }: { pagination?: { cursor?: string } } = {}) => {
        const pageIndex =
          pagination?.cursor === undefined ? 0 : Number(pagination.cursor.slice("page-".length));
        const next = pageIndex + 1;
        return {
          data: runPages[pageIndex] ?? [],
          hasMore: next < runPages.length,
          cursor: next < runPages.length ? `page-${next}` : null,
        };
      },
    },
    hooks: {
      getByToken: async (token: string) => {
        const hook = hooks.find((candidate) => candidate.token === token);
        if (hook === undefined) throw new HookNotFoundError(token);
        return hook;
      },
      list: async ({ runId }: { runId?: string }) => ({
        data: runId === undefined ? hooks : hooks.filter((hook) => hook.runId === runId),
      }),
    },
  } as unknown as Parameters<typeof setWorld>[0]);
}

const storedTicket = (ticket: string) => [[1], { ticket: 2 }, ticket];

test("only a run's exact, full ID names it", async () => {
  world({ runs: [worldRun(), worldRun({ runId: RUN_B })] });
  expect(await runExists(RUN_A)).toBe(true);
  expect(await runExists(RUN_A.toLowerCase())).toBe(false);
  expect(await runExists("01K3ANBZ")).toBe(false);
  expect(await runExists("wrun_01K3ANBZ")).toBe(false);
  expect(await runExists(RUN_A.slice("wrun_".length))).toBe(false);
});

test("a ticket names no run, even the one launched for it", async () => {
  world({ runs: [worldRun({ input: storedTicket("AGE-317") })] });
  expect(await runExists("AGE-317")).toBe(false);
  expect(await runExists("age-317")).toBe(false);
});

test("a full-length run ID nobody minted names no run", async () => {
  world({ runs: [worldRun()] });
  expect(await runExists("wrun_01ZZZZZZZZZZZZZZZZZZZZZZZZ")).toBe(false);
});

// Compiled workflows carry the workflowId the world records as workflowName;
// the fixture stamps one so the mapping has something to map.
const STAMPED_WORKFLOW_ID = "workflow//./workflows/crash//crashWorkflow";

const stampedWorkflow = Object.assign(async () => undefined, {
  workflowId: STAMPED_WORKFLOW_ID,
});

const factory: Factory = {
  workflows: {
    stamped: { workflow: stampedWorkflow, inputs: z.object({}) },
    // Untransformed, so it contributes no mapping — as a plain import does.
    unstamped: {
      workflow: async () => undefined,
      inputs: z.object({}),
    },
  },
};

const worldRun = (over: Partial<StoredRun> = {}): StoredRun => ({
  runId: RUN_A,
  workflowName: STAMPED_WORKFLOW_ID,
  status: "running",
  createdAt: new Date("2026-08-26T10:00:00.000Z"),
  ...over,
});

// A run's arguments as the world stores them: devalue-flattened, index 0 the
// root. This is `[{ triggerId }]` in that form — the only place a trigger is
// written down, and what the listing has to read it back out of.
const storedArgs = (triggerId: string) => [[1], { triggerId: 2 }, triggerId];

const PARK_TOKEN = pullRequestToken({ owner: "acme", repo: "api", number: 41 });

test("the listing follows every SDK cursor", async () => {
  world({ runPages: [[worldRun({ runId: RUN_B })], [worldRun()]] });
  const rows = await listRuns(factory);
  expect(rows.map((row) => row.runId).sort()).toEqual([RUN_A, RUN_B]);
});

test("a run parked on a hook keeps the SDK's status and lists what it waits for", async () => {
  world({
    runs: [worldRun()],
    hooks: [{ runId: RUN_A, token: PARK_TOKEN }],
  });
  const rows = await listRuns(factory);
  expect(rows[0]).toMatchObject({
    status: "running",
    suspensions: [{ reason: "waiting for pull request activity on acme/api#41" }],
  });
});

const inFlight: stalls.StepView = {
  name: "executeAgent",
  status: "running",
  attempt: 1,
  startedAt: "2026-08-26T10:00:01.000Z",
  completedAt: null,
  error: null,
};

// The run route reads one run's facts and the listing every run's, and both
// describe them with describeRunState. Same answers.
const storedRun = (status: string) => ({
  status,
  workflowName: STAMPED_WORKFLOW_ID,
  trigger: "manual",
  ticket: null,
  createdAt: new Date("2026-08-26T10:00:00.000Z"),
});

test("describeRunState is the one thing status list and detail both read", async () => {
  const describe = (status: string, tokens: string[]) =>
    describeRunState(RUN_A, { run: storedRun(status), tokens }, []);
  const PARK = [PARK_TOKEN];

  expect(await describe("running", [])).toMatchObject({
    status: "running",
    suspensions: [],
  });
  expect(await describe("running", PARK)).toMatchObject({
    status: "running",
    suspensions: [
      {
        token: PARK[0],
        reason: "waiting for pull request activity on acme/api#41",
      },
    ],
  });
  expect(await describe("failed", [])).toMatchObject({
    status: "failed",
  });
  expect(await describe("pending", PARK)).toMatchObject({
    status: "pending",
    suspensions: [{ token: PARK[0] }],
  });
});

test("a run holding only its ticket claim is not parked", async () => {
  world({
    runs: [worldRun()],
    hooks: [{ runId: RUN_A, token: ticketToken(crypto.randomUUID()) }],
  });
  const rows = await listRuns(factory);
  expect(rows[0]?.status).toBe("running");
});

test("a terminal run that still lists a hook keeps its own status", async () => {
  world({
    runs: [worldRun({ status: "failed" })],
    hooks: [{ runId: RUN_A, token: PARK_TOKEN }],
  });
  const rows = await listRuns(factory);
  expect(rows[0]?.status).toBe("failed");
});

test("runs are listed newest first", async () => {
  world({
    runs: [
      worldRun({ createdAt: new Date("2026-08-26T09:00:00.000Z") }),
      worldRun({
        runId: RUN_B,
        createdAt: new Date("2026-08-26T11:00:00.000Z"),
      }),
    ],
  });
  const rows = await listRuns(factory);
  expect(rows.map((row) => row.runId)).toEqual([RUN_B, RUN_A]);
});

test("a stamped workflow id is reported as the name its factory gave it", async () => {
  world({ runs: [worldRun()] });
  const rows = await listRuns(factory);
  expect(rows[0]?.workflow).toBe("stamped");
});

test("an unmapped workflow name is reported verbatim rather than guessed at", async () => {
  world({ runs: [worldRun({ workflowName: "workflow//./nope//x" })] });
  const rows = await listRuns(factory);
  expect(rows[0]?.workflow).toBe("workflow//./nope//x");
});

test("a run launched by hand reads as a manual trigger", async () => {
  world({ runs: [worldRun({ input: storedArgs(crypto.randomUUID()) })] });
  const rows = await listRuns(factory);
  expect(rows[0]?.trigger).toBe("manual");
});

test("a scheduled run names its schedule, without the tick it fired on", async () => {
  const triggerId = scheduleTriggerId("nightly-sweep", new Date("2026-08-26T03:00:00.400Z"));
  expect(triggerId).toBe("schedule:nightly-sweep:2026-08-26T03:00:00Z");
  world({ runs: [worldRun({ input: storedArgs(triggerId) })] });
  const rows = await listRuns(factory);
  expect(rows[0]?.trigger).toBe("schedule:nightly-sweep");
});

test("a run whose inputs cannot be read reads as manual, like every other launch", async () => {
  // What an encrypted World stores: bytes the hydrator hands back untouched.
  const encrypted = new TextEncoder().encode("encrciphertext");
  world({ runs: [worldRun({ input: encrypted })] });
  const rows = await listRuns(factory);
  expect(rows[0]?.trigger).toBe("manual");
});

const storedLaunch = (fields: Record<string, string>) => [
  [1],
  Object.fromEntries(Object.keys(fields).map((key, index) => [key, index + 2])),
  ...Object.values(fields),
];

test("a run names its ticket and keeps its parked pull request in WAITING", async () => {
  const githubRead = vi.spyOn(github, "fetchPrSnapshot");
  world({
    runs: [worldRun({ input: storedLaunch({ ticket: "AGE-317", triggerId: "manual" }) })],
    hooks: [{ runId: RUN_A, token: PARK_TOKEN }],
  });
  const row = (await listRuns(factory))[0];
  expect(row?.ticket).toBe("AGE-317");
  expect(row?.suspensions[0]?.reason).toBe("waiting for pull request activity on acme/api#41");
  expect(row?.suspensions[0]?.url).toBe("https://github.com/acme/api/pull/41");
  // The listing behind status and watch stays provider-free; only the single-run
  // route calls enrichSuspensions.
  expect(githubRead).not.toHaveBeenCalled();
});

test("a terminal run uses its completion time without interpreting its result", async () => {
  world({
    runs: [
      worldRun({
        status: "completed",
        completedAt: new Date("2026-08-26T12:00:00.000Z"),
        output: [
          { status: 1, pr: 2 },
          "merged",
          { owner: 3, repo: 4, number: 5 },
          "acme",
          "api",
          41,
        ],
      }),
    ],
  });
  const row = (await listRuns(factory))[0];
  expect(row?.lastActivityAt).toBe("2026-08-26T12:00:00.000Z");
});

test("a terminal run's step count is null in the listing, not a zero it never read", async () => {
  world({ runs: [worldRun({ status: "completed", completedAt: new Date() })] });
  const row = (await listRuns(factory))[0];
  expect(row?.steps).toBeNull();
  expect(row?.lastStep).toBeNull();
});

// What the single-run route does: it holds the steps already, so a finished
// run says how far it got rather than reporting nothing.
test("a terminal run reports its steps to a caller that already read them", async () => {
  const steps: stalls.StepView[] = [
    {
      ...inFlight,
      name: "claimTicket",
      status: "completed",
      completedAt: "2026-08-26T10:00:02.000Z",
    },
  ];
  const described = describeRunState(RUN_A, { run: storedRun("completed"), steps }, []);
  expect(described.steps).toBe(1);
  expect(described.lastStep).toEqual({
    name: "claimTicket",
    status: "completed",
    at: "2026-08-26T10:00:02.000Z",
  });
});

test("last activity is the run's newest step, not the moment it was created", async () => {
  world({
    runs: [worldRun({ updatedAt: new Date("2026-08-26T10:00:05.000Z") })],
    steps: {
      [RUN_A]: [
        {
          stepName: "claimTicket",
          status: "completed",
          attempt: 1,
          createdAt: new Date("2026-08-26T10:00:01.000Z"),
          startedAt: new Date("2026-08-26T10:00:01.000Z"),
          completedAt: new Date("2026-08-26T10:00:02.000Z"),
        },
        {
          stepName: "executeAgent",
          status: "running",
          attempt: 1,
          createdAt: new Date("2026-08-26T10:00:03.000Z"),
          startedAt: new Date("2026-08-26T10:20:00.000Z"),
        },
      ],
    },
  });
  const row = (await listRuns(factory))[0];
  expect(row?.lastActivityAt).toBe("2026-08-26T10:20:00.000Z");
  expect(row?.steps).toBe(2);
  expect(row?.lastStep).toEqual({
    name: "executeAgent",
    status: "running",
    at: "2026-08-26T10:20:00.000Z",
  });
});
