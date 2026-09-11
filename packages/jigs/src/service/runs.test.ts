import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { HookNotFoundError, WorkflowRunNotFoundError } from "workflow/errors";
import { setWorld } from "workflow/runtime";
import { z } from "zod";
import type { Factory } from "./factory.ts";
import * as linear from "./providers/linear.ts";
import {
  describeRun,
  listRuns,
  parkReason,
  resolveRunRef,
  scheduleTriggerId,
  type WorldRun,
} from "./runs.ts";
import * as stalls from "./stalls.ts";
import { ticketToken } from "./suspension/claim.ts";
import { needsHumanToken } from "./suspension/needs-human.ts";
import { prToken } from "./suspension/pull-request-gate.ts";
import * as sql from "./worktrees/sql.ts";

const RUN_A = "wrun_01K3ANBZ4TQ8W9YV6H2E5C7DKM";
const RUN_B = "wrun_01K3ANC1P0R4S6TXZ8B3F5G7HJ";

// Everything here is read off the world the SDK hands jigs, so the world is
// what a test stands up — the same seam app.test.ts uses. The dead-job read
// would otherwise open a real connection to the operator's own World.
beforeEach(() => {
  vi.spyOn(sql, "registrySql").mockReturnValue({} as never);
  vi.spyOn(stalls, "listJobRunIds").mockResolvedValue({ dead: [], live: [] });
  world();
});
afterEach(() => {
  vi.restoreAllMocks();
  setWorld(undefined);
});

interface StoredRun extends WorldRun {
  input?: unknown;
}

interface Fixture {
  runs?: StoredRun[];
  hooks?: Array<{ runId: string; token: string }>;
}

function world(fixture: Fixture = {}): void {
  const runs = fixture.runs ?? [];
  const hooks = fixture.hooks ?? [];
  setWorld({
    runs: {
      get: async (runId: string) => {
        const run = runs.find((candidate) => candidate.runId === runId);
        if (run === undefined) throw new WorkflowRunNotFoundError(runId);
        return run;
      },
      list: async () => ({ data: runs }),
    },
    hooks: {
      getByToken: async (token: string) => {
        const hook = hooks.find((candidate) => candidate.token === token);
        if (hook === undefined) throw new HookNotFoundError(token);
        return hook;
      },
      list: async ({ runId }: { runId?: string }) => ({
        data:
          runId === undefined
            ? hooks
            : hooks.filter((hook) => hook.runId === runId),
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

test("a prefix matching two runs is ambiguous and names both", async () => {
  world({ runs: [worldRun(), worldRun({ runId: RUN_B })] });
  const ref = await resolveRunRef("01K3AN");
  expect(ref.kind).toBe("ambiguous");
  expect(ref.kind === "ambiguous" && ref.candidates).toEqual([RUN_A, RUN_B]);
});

const ISSUE_317 = "68bc9696-35d5-442d-ab56-214c8cfefbec";

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
  expect(parkReason(ticketToken(crypto.randomUUID()))).toBeNull();
  expect(parkReason(prToken({ owner: "acme", repo: "api", number: 41 }))).toBe(
    "awaiting pull request review",
  );
  expect(parkReason(needsHumanToken("issue-1", "comment-1"))).toBe(
    "needs a human on the ticket",
  );
  // A pipeline of its own that parks on createHook({ token }) is parked too,
  // so parkedness can never depend on jigs recognizing the token.
  expect(parkReason(`demo:${crypto.randomUUID()}`)).toBe(
    "awaiting an external event",
  );
});

// Compiled pipelines carry the workflowId the world records as workflowName;
// the fixture stamps one so the mapping has something to map.
const STAMPED_WORKFLOW_ID = "workflow//./pipelines/crash//crashPipeline";

const stampedPipeline = Object.assign(async () => undefined, {
  workflowId: STAMPED_WORKFLOW_ID,
});

const factory: Factory = {
  pipelines: {
    stamped: { pipeline: stampedPipeline, inputs: z.object({}) },
    // Untransformed, so it contributes no mapping — as a plain import does.
    unstamped: {
      pipeline: async () => undefined,
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

const PARK_TOKEN = prToken({ owner: "acme", repo: "api", number: 41 });

test("a non-terminal run holding a park hook is reported suspended", async () => {
  world({
    runs: [worldRun()],
    hooks: [{ runId: RUN_A, token: PARK_TOKEN }],
  });
  const rows = await listRuns(factory);
  expect(rows[0]?.status).toBe("suspended");
});

const jobs = (dead: string[], live: string[] = []) =>
  vi.spyOn(stalls, "listJobRunIds").mockResolvedValue({ dead, live });

test("a running run with a dead job and nothing in flight is stalled", async () => {
  world({ runs: [worldRun()] });
  jobs([RUN_A]);
  vi.spyOn(stalls, "runsWithActiveStep").mockResolvedValue([]);
  const rows = await listRuns(factory);
  expect(rows[0]?.status).toBe("stalled");
});

test("a dead job beside a step still in flight is not a stall", async () => {
  world({ runs: [worldRun()] });
  jobs([RUN_A]);
  vi.spyOn(stalls, "runsWithActiveStep").mockResolvedValue([RUN_A]);
  const rows = await listRuns(factory);
  expect(rows[0]?.status).toBe("running");
});

test("a healed run is not stalled: the dead row stays, but a live job replaced it", async () => {
  // A requeue and the World's own restart reconciliation each add a job
  // beside the dead one, which nothing ever clears — so a recovered run would
  // otherwise read stalled in every gap between its steps.
  world({ runs: [worldRun()] });
  jobs([RUN_A], [RUN_A]);
  vi.spyOn(stalls, "runsWithActiveStep").mockResolvedValue([]);
  const rows = await listRuns(factory);
  expect(rows[0]?.status).toBe("running");
});

test("a run parked on a hook reads suspended even with a dead job", async () => {
  world({
    runs: [worldRun()],
    hooks: [{ runId: RUN_A, token: PARK_TOKEN }],
  });
  jobs([RUN_A]);
  vi.spyOn(stalls, "runsWithActiveStep").mockResolvedValue([]);
  const rows = await listRuns(factory);
  expect(rows[0]?.status).toBe("suspended");
});

test("a dead job left behind by a terminal run does not restate its status", async () => {
  world({ runs: [worldRun({ status: "completed" })] });
  jobs([RUN_A]);
  vi.spyOn(stalls, "runsWithActiveStep").mockResolvedValue([]);
  const rows = await listRuns(factory);
  expect(rows[0]?.status).toBe("completed");
});

// The run route reads describeRun for one run and lets it fetch; the listing
// above reads it for every run off facts it already holds. Same answers.
test("describeRun is the one thing `jigs ps` and the run route both read", async () => {
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
    suspensions: [{ token: PARK[0], reason: "awaiting pull request review" }],
  });
  expect(await describe("failed", [], true)).toMatchObject({
    status: "failed",
  });
  expect(await describe("pending", [], true)).toMatchObject({
    status: "pending",
  });
  // The disagreement this replaced: the run route derived a status only for a
  // `running` run, so a parked `pending` one read `suspended` in `jigs ps` and
  // `pending` in `jigs logs`.
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
  expect(rows[0]?.pipeline).toBe("stamped");
});

test("an unmapped workflow name is reported verbatim rather than guessed at", async () => {
  world({ runs: [worldRun({ workflowName: "workflow//./nope//x" })] });
  const rows = await listRuns(factory);
  expect(rows[0]?.pipeline).toBe("workflow//./nope//x");
});

test("a run launched by hand reads as a manual trigger", async () => {
  world({ runs: [worldRun({ input: storedArgs(crypto.randomUUID()) })] });
  const rows = await listRuns(factory);
  expect(rows[0]?.trigger).toBe("manual");
});

test("a scheduled run names its schedule, without the tick it fired on", async () => {
  const triggerId = scheduleTriggerId(
    "nightly-sweep",
    new Date("2026-08-26T03:00:00.400Z"),
  );
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
