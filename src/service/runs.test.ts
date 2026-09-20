import { SPEC_VERSION_CURRENT } from "@workflow/world";
import { afterAll, afterEach, beforeEach, expect, test, vi } from "vitest";
import { HookNotFoundError, WorkflowRunNotFoundError } from "workflow/errors";
import { setWorld } from "workflow/runtime";
import { z } from "zod";
import type { Factory } from "../blocks/factory.ts";
import { ticketToken } from "../blocks/linear/claim.ts";
import { needsHumanToken } from "../blocks/linear/halt-for-human.ts";
import { pullRequestToken } from "../blocks/pull-requests/gate.ts";
import { resourceAttribute } from "../blocks/runtime/resources.ts";
import * as config from "../config/factory-config.ts";
import * as root from "../config/factory-root.ts";
import * as github from "../providers/github.ts";
import * as linear from "../providers/linear.ts";
import type { RunSuspension } from "../run-suspension.ts";
import * as sql from "../steps/workspaces/sql.ts";
import * as queue from "./queue.ts";
import {
  describeRun,
  describeSuspension,
  enrichSuspensions,
  listRunResources,
  listRuns,
  resolveRunRef,
  scheduleTriggerId,
  type WorldRun,
} from "./runs.ts";
import * as stalls from "./stalls.ts";
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
// what a test stands up — the same seam app.test.ts uses. The dead-job read
// would otherwise open a real connection to the operator's own World.
beforeEach(() => {
  clearWakes();
  vi.spyOn(sql, "registrySql").mockReturnValue({} as never);
  vi.spyOn(queue, "listJobRunIds").mockResolvedValue({ dead: [], live: [] });
  world();
});

const prSnapshot = (
  patch: Partial<github.PullRequestSnapshot> = {},
): github.PullRequestSnapshot => ({
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
    service: { port: 8990, dashboardPort: 9090 },
    github: { identities: [{ mode: "pat" }] },
    merge: { by: "human", method: "squash", approval: { kind: "review" } },
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

// Refusing the Linear lookup is how a test asserts that a ref never left the
// machine; `issues` stands in for the identifiers a workspace can place.
function linearPlaces(issues: Record<string, string> = {}): void {
  vi.spyOn(linear, "resolveIssueRef").mockImplementation(async (ref) => {
    const id = issues[ref];
    if (id === undefined) throw new Error(`Linear issue not found: ${ref}`);
    return { id, identifier: ref };
  });
}

const NO_LINEAR = () =>
  vi.spyOn(linear, "resolveIssueRef").mockImplementation(() => {
    throw new Error("Linear must not be asked about this ref");
  });

test("a full run id resolves to itself", async () => {
  world({ runs: [worldRun(), worldRun({ runId: RUN_B })] });
  expect(await resolveRunRef(RUN_A)).toEqual({ kind: "found", runId: RUN_A });
});

test("run resources are decoded from attributes without reading workflow output", async () => {
  const resource = {
    kind: "custom-report",
    identity: "quarter:2026-Q3",
    url: "https://example.test/reports/2026-Q3",
  };
  const attribute = resourceAttribute(resource);
  world({
    runs: [
      worldRun({
        attributes: {
          phase: "complete",
          $parentRunId: RUN_B,
          [attribute.key]: attribute.value,
        },
      }),
    ],
  });
  expect(await listRunResources(RUN_A)).toEqual([resource]);
});

test("a unique ULID prefix resolves, case-insensitively and bare", async () => {
  world({ runs: [worldRun(), worldRun({ runId: RUN_B })] });
  expect(await resolveRunRef("01k3anbz")).toEqual({
    kind: "found",
    runId: RUN_A,
  });
});

test("the same prefix resolves with the wrun_ prefix typed out", async () => {
  world({ runs: [worldRun(), worldRun({ runId: RUN_B })] });
  expect(await resolveRunRef("wrun_01K3ANBZ")).toEqual({
    kind: "found",
    runId: RUN_A,
  });
});

test("prefix resolution follows every SDK cursor before deciding uniqueness", async () => {
  world({
    runs: [worldRun({ runId: RUN_B }), worldRun()],
    runPages: [[worldRun({ runId: RUN_B })], [worldRun()]],
  });
  expect(await resolveRunRef("01K3ANBZ")).toEqual({ kind: "found", runId: RUN_A });
});

test("a prefix matching two runs is ambiguous and names both", async () => {
  world({ runs: [worldRun(), worldRun({ runId: RUN_B })] });
  const ref = await resolveRunRef("01K3AN");
  expect(ref.kind).toBe("ambiguous");
  expect(ref.kind === "ambiguous" && ref.candidates).toEqual([RUN_A, RUN_B]);
});

const ISSUE_317 = "68bc9696-35d5-442d-ab56-214c8cfefbec";
const storedTicket = (ticket: string) => [[1], { ticket: 2 }, ticket];

test("a terminal run remains selectable by its stored ticket identifier", async () => {
  world({ runs: [worldRun({ status: "completed", input: storedTicket("AGE-317") })] });
  linearPlaces({ "AGE-317": ISSUE_317 });
  expect(await resolveRunRef("age-317")).toEqual({ kind: "found", runId: RUN_A });
});

test("multiple executions for one ticket are ambiguous", async () => {
  world({
    runs: [
      worldRun({ status: "completed", input: storedTicket("AGE-317") }),
      worldRun({ runId: RUN_B, input: storedTicket("AGE-317") }),
    ],
  });
  linearPlaces({ "AGE-317": ISSUE_317 });
  expect(await resolveRunRef("AGE-317")).toEqual({
    kind: "ambiguous",
    candidates: [RUN_A, RUN_B],
  });
});

test("a historical ticket match and its current claim owner are ambiguous", async () => {
  world({
    runs: [
      worldRun({ status: "completed", input: storedTicket("AGE-317") }),
      worldRun({ runId: RUN_B }),
    ],
    hooks: [{ runId: RUN_B, token: ticketToken(ISSUE_317) }],
  });
  linearPlaces({ "AGE-317": ISSUE_317 });
  expect(await resolveRunRef("AGE-317")).toEqual({
    kind: "ambiguous",
    candidates: [RUN_A, RUN_B],
  });
});

test("a terminal run remains selectable by its stored ticket UUID", async () => {
  world({ runs: [worldRun({ status: "failed", input: storedTicket(ISSUE_317) })] });
  NO_LINEAR();
  expect(await resolveRunRef(ISSUE_317.toUpperCase())).toEqual({
    kind: "found",
    runId: RUN_A,
  });
});

test("a ticket identifier resolves through Linear, then the claim hook", async () => {
  world({
    runs: [worldRun()],
    hooks: [{ runId: RUN_A, token: ticketToken(ISSUE_317) }],
  });
  linearPlaces({ "AGE-317": ISSUE_317 });
  expect(await resolveRunRef("AGE-317")).toEqual({
    kind: "found",
    runId: RUN_A,
  });
});

test("a lowercase ticket identifier retries with its canonical casing", async () => {
  world({
    runs: [worldRun()],
    hooks: [{ runId: RUN_A, token: ticketToken(ISSUE_317) }],
  });
  linearPlaces({ "AGE-317": ISSUE_317 });
  expect(await resolveRunRef("age-317")).toEqual({
    kind: "found",
    runId: RUN_A,
  });
});

test("an identifier Linear places on a ticket no run holds is unknown", async () => {
  world({ runs: [worldRun()] });
  linearPlaces({ "AGE-317": ISSUE_317 });
  expect(await resolveRunRef("AGE-317")).toEqual({ kind: "unknown" });
});

test("a ticket UUID — what the claim hook is keyed on — makes no Linear call", async () => {
  const issueId = crypto.randomUUID();
  world({
    runs: [worldRun({ runId: RUN_B })],
    hooks: [{ runId: RUN_B, token: ticketToken(issueId) }],
  });
  NO_LINEAR();
  expect(await resolveRunRef(issueId)).toEqual({
    kind: "found",
    runId: RUN_B,
  });
});

test("a ticket UUID no run holds is unknown, still without a Linear call", async () => {
  world({ runs: [worldRun({ runId: RUN_B })] });
  NO_LINEAR();
  expect(await resolveRunRef(crypto.randomUUID())).toEqual({ kind: "unknown" });
});

test("a ref shaped like neither a run nor an identifier asks Linear nothing", async () => {
  world({ runs: [worldRun()] });
  NO_LINEAR();
  expect(await resolveRunRef("not-a-ticket-at-all")).toEqual({
    kind: "unknown",
  });
});

test("an identifier Linear cannot place is unknown", async () => {
  world({ runs: [worldRun()] });
  linearPlaces();
  expect(await resolveRunRef("AGE-999")).toEqual({ kind: "unknown" });
});

test("a full-length run id nobody minted falls through to unknown", async () => {
  world({ runs: [worldRun()] });
  expect(await resolveRunRef("wrun_01ZZZZZZZZZZZZZZZZZZZZZZZZ")).toEqual({
    kind: "unknown",
  });
});

// Read through the minters, never through a token spelled out here: a reason
// derived from a prefix the minters no longer produce degrades to the generic
// one, and a test carrying its own copy of the prefix would stay green.
test("a ticket claim is not a park, and every other hook explains itself", () => {
  expect(describeSuspension(ticketToken(crypto.randomUUID()))).toBeNull();
  expect(describeSuspension(pullRequestToken({ owner: "acme", repo: "api", number: 41 }))).toEqual({
    token: "github:pr:acme/api#41",
    kind: "pull-request",
    reason: "waiting for an approving review and green CI on acme/api#41",
    url: "https://github.com/acme/api/pull/41",
  });
  // The ticket the run was launched with, never the issue UUID in the token:
  // the identifier is what an operator can act on.
  expect(describeSuspension(needsHumanToken("issue-1", "comment-1"), "AGE-317")).toEqual({
    token: "jigs:needs-human:issue-1:comment-1",
    kind: "needs-human",
    reason: "waiting for a human reply on AGE-317",
  });
  // A workflow of its own that parks on createHook({ token }) is parked too,
  // so parkedness can never depend on jigs recognizing the token.
  expect(describeSuspension("demo:thing")).toEqual({
    token: "demo:thing",
    kind: "external",
    reason: "waiting for an external event (demo:thing)",
  });
});

// A token jigs minted but cannot take apart is still jigs' own park: the kind
// says what to do about it, and only the details are missing.
test("a park jigs minted keeps its kind when the rest of the token is unreadable", () => {
  expect(describeSuspension("github:pr:garbage")).toEqual({
    token: "github:pr:garbage",
    kind: "pull-request",
    reason: "waiting for an approving review and green CI on garbage",
  });
  expect(describeSuspension("jigs:needs-human:onlyone")).toEqual({
    token: "jigs:needs-human:onlyone",
    kind: "needs-human",
    reason:
      "waiting for a human reply, on a ticket this halt marker does not name (jigs:needs-human:onlyone)",
  });
  // The run was launched with a ticket, so the marker does not have to name one.
  expect(describeSuspension("jigs:needs-human:onlyone", "AGE-317")).toMatchObject({
    kind: "needs-human",
    reason: "waiting for a human reply on AGE-317",
  });
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

test("a non-terminal run holding a park hook is reported suspended", async () => {
  world({
    runs: [worldRun()],
    hooks: [{ runId: RUN_A, token: PARK_TOKEN }],
  });
  const rows = await listRuns(factory);
  expect(rows[0]?.status).toBe("suspended");
});

const jobs = (dead: string[], live: string[] = []) =>
  vi.spyOn(queue, "listJobRunIds").mockResolvedValue({ dead, live });

const inFlight: stalls.StepView = {
  name: "executeAgent",
  status: "running",
  attempt: 1,
  startedAt: "2026-08-26T10:00:01.000Z",
  completedAt: null,
  error: null,
};

test("a running run with a dead job and nothing in flight is stalled", async () => {
  world({ runs: [worldRun()] });
  jobs([RUN_A]);
  vi.spyOn(stalls, "listStepsByRun").mockResolvedValue(new Map([[RUN_A, []]]));
  const rows = await listRuns(factory);
  expect(rows[0]?.status).toBe("stalled");
});

test("a dead job beside a step still in flight is not a stall", async () => {
  world({ runs: [worldRun()] });
  jobs([RUN_A]);
  vi.spyOn(stalls, "listStepsByRun").mockResolvedValue(new Map([[RUN_A, [inFlight]]]));
  const rows = await listRuns(factory);
  expect(rows[0]?.status).toBe("running");
});

test("a healed run is not stalled: the dead row stays, but a live job replaced it", async () => {
  // A requeue and the World's own restart reconciliation each add a job
  // beside the dead one, which nothing ever clears — so a recovered run would
  // otherwise read stalled in every gap between its steps.
  world({ runs: [worldRun()] });
  jobs([RUN_A], [RUN_A]);
  vi.spyOn(stalls, "listStepsByRun").mockResolvedValue(new Map([[RUN_A, []]]));
  const rows = await listRuns(factory);
  expect(rows[0]?.status).toBe("running");
});

test("a run parked on a hook reads suspended even with a dead job", async () => {
  world({
    runs: [worldRun()],
    hooks: [{ runId: RUN_A, token: PARK_TOKEN }],
  });
  jobs([RUN_A]);
  vi.spyOn(stalls, "listStepsByRun").mockResolvedValue(new Map([[RUN_A, []]]));
  const rows = await listRuns(factory);
  expect(rows[0]?.status).toBe("suspended");
});

test("a dead job left behind by a terminal run does not restate its status", async () => {
  world({ runs: [worldRun({ status: "completed" })] });
  jobs([RUN_A]);
  vi.spyOn(stalls, "listStepsByRun").mockResolvedValue(new Map([[RUN_A, []]]));
  const rows = await listRuns(factory);
  expect(rows[0]?.status).toBe("completed");
});

// The run route reads describeRun for one run and lets it fetch; the listing
// above reads it for every run off facts it already holds. Same answers.
test("describeRun is the one thing status list and detail both read", async () => {
  const describe = (status: string, tokens: string[], stalled: boolean) =>
    describeRun(RUN_A, { run: worldRun({ status }), tokens, stalled });
  const PARK = [PARK_TOKEN];

  expect(await describe("running", [], true)).toMatchObject({
    status: "stalled",
    suspended: false,
  });
  expect(await describe("running", PARK, true)).toMatchObject({
    status: "suspended",
    suspended: true,
    suspensions: [
      {
        token: PARK[0],
        reason: "waiting for an approving review and green CI on acme/api#41",
      },
    ],
  });
  expect(await describe("failed", [], true)).toMatchObject({
    status: "failed",
  });
  expect(await describe("pending", [], true)).toMatchObject({
    status: "pending",
  });
  // The disagreement this replaced: the run route derived a status only for a
  // `running` run, so list and detail once disagreed about a parked pending run.
  expect(await describe("pending", PARK, false)).toMatchObject({
    status: "suspended",
    suspended: true,
  });
});

test("a run holding only its ticket claim is still running, not suspended", async () => {
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
  expect(row?.suspensions[0]?.reason).toBe(
    "waiting for an approving review and green CI on acme/api#41",
  );
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
  const described = await describeRun(RUN_A, {
    run: worldRun({ status: "completed" }),
    steps,
  });
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
