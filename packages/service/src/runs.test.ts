import { beforeEach, expect, test, vi } from "vitest";
import { z } from "zod";
import type { Factory } from "./factory";
import {
  derivedRunStatus,
  isParkToken,
  listRuns,
  resolveRunRef,
  scheduleTriggerId,
  type WorldRun,
} from "./runs";
import * as stalls from "./stalls";
import * as sql from "./worktrees/sql";

const RUN_A = "wrun_01K3ANBZ4TQ8W9YV6H2E5C7DKM";
const RUN_B = "wrun_01K3ANC1P0R4S6TXZ8B3F5G7HJ";

// The dead-job read would otherwise open a real connection to the operator's
// own World.
beforeEach(() => {
  vi.spyOn(sql, "registrySql").mockReturnValue({} as never);
  vi.spyOn(stalls, "listJobRunIds").mockResolvedValue({ dead: [], live: [] });
});

// `issues` stands in for the Linear lookup the ticket branch makes: the
// identifiers the workspace can place, mapped to the issue UUID the claim
// hook is keyed on. Refusing the lookup is how a test asserts that a ref
// never left the machine.
const NO_LINEAR = () =>
  Promise.reject(new Error("Linear must not be asked about this ref"));

const lookupDeps = (
  runIds: string[],
  hooks: Record<string, string> = {},
  issues: Record<string, string> = {},
) => ({
  listRunIds: async () => runIds,
  runExists: async (id: string) => runIds.includes(id),
  hookRunId: async (token: string) => hooks[token] ?? null,
  issueId: async (ref: string) => issues[ref] ?? null,
});

test("a full run id resolves to itself", async () => {
  const ref = await resolveRunRef(RUN_A, lookupDeps([RUN_A, RUN_B]));
  expect(ref).toEqual({ kind: "found", runId: RUN_A });
});

test("a unique ULID prefix resolves, case-insensitively and bare", async () => {
  const ref = await resolveRunRef("01k3anbz", lookupDeps([RUN_A, RUN_B]));
  expect(ref).toEqual({ kind: "found", runId: RUN_A });
});

test("the same prefix resolves with the wrun_ prefix typed out", async () => {
  const ref = await resolveRunRef("wrun_01K3ANBZ", lookupDeps([RUN_A, RUN_B]));
  expect(ref).toEqual({ kind: "found", runId: RUN_A });
});

test("a prefix matching two runs is ambiguous and names both", async () => {
  const ref = await resolveRunRef("01K3AN", lookupDeps([RUN_A, RUN_B]));
  expect(ref.kind).toBe("ambiguous");
  expect(ref.kind === "ambiguous" && ref.candidates).toEqual([RUN_A, RUN_B]);
});

const ISSUE_317 = "68bc9696-35d5-442d-ab56-214c8cfefbec";

test("a ticket identifier resolves through Linear, then the claim hook", async () => {
  const ref = await resolveRunRef(
    "AGE-317",
    lookupDeps(
      [RUN_A],
      { [`linear:ticket:${ISSUE_317}`]: RUN_A },
      { "AGE-317": ISSUE_317 },
    ),
  );
  expect(ref).toEqual({ kind: "found", runId: RUN_A });
});

test("a lowercase ticket identifier retries with its canonical casing", async () => {
  const ref = await resolveRunRef(
    "age-317",
    lookupDeps(
      [RUN_A],
      { [`linear:ticket:${ISSUE_317}`]: RUN_A },
      { "AGE-317": ISSUE_317 },
    ),
  );
  expect(ref).toEqual({ kind: "found", runId: RUN_A });
});

test("an identifier Linear places on a ticket no run holds is unknown", async () => {
  const ref = await resolveRunRef(
    "AGE-317",
    lookupDeps([RUN_A], {}, { "AGE-317": ISSUE_317 }),
  );
  expect(ref).toEqual({ kind: "unknown" });
});

test("a ticket UUID — what the claim hook is keyed on — makes no Linear call", async () => {
  const issueId = crypto.randomUUID();
  const ref = await resolveRunRef(issueId, {
    ...lookupDeps([RUN_B], { [`linear:ticket:${issueId}`]: RUN_B }),
    issueId: NO_LINEAR,
  });
  expect(ref).toEqual({ kind: "found", runId: RUN_B });
});

test("a ticket UUID no run holds is unknown, still without a Linear call", async () => {
  const ref = await resolveRunRef(crypto.randomUUID(), {
    ...lookupDeps([RUN_B]),
    issueId: NO_LINEAR,
  });
  expect(ref).toEqual({ kind: "unknown" });
});

test("a ref shaped like neither a run nor an identifier asks Linear nothing", async () => {
  const ref = await resolveRunRef("not-a-ticket-at-all", {
    ...lookupDeps([RUN_A]),
    issueId: NO_LINEAR,
  });
  expect(ref).toEqual({ kind: "unknown" });
});

test("an identifier Linear cannot place is unknown", async () => {
  const ref = await resolveRunRef("AGE-999", lookupDeps([RUN_A]));
  expect(ref).toEqual({ kind: "unknown" });
});

test("a full-length run id nobody minted falls through to unknown", async () => {
  const ref = await resolveRunRef(
    "wrun_01ZZZZZZZZZZZZZZZZZZZZZZZZ",
    lookupDeps([RUN_A]),
  );
  expect(ref).toEqual({ kind: "unknown" });
});

test("a ticket claim is not a park, and a metadata-less hook still is", () => {
  expect(isParkToken(`linear:ticket:${crypto.randomUUID()}`)).toBe(false);
  // A pipeline that parks on createHook({ token }) with no metadata is still
  // parked, so parkedness cannot depend on a hydratable suspension envelope.
  expect(isParkToken(`demo:${crypto.randomUUID()}`)).toBe(true);
  expect(isParkToken("github:pr:acme/api#41")).toBe(true);
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

const worldRun = (over: Partial<WorldRun> = {}): WorldRun => ({
  runId: RUN_A,
  workflowName: STAMPED_WORKFLOW_ID,
  status: "running",
  createdAt: new Date("2026-08-26T10:00:00.000Z"),
  ...over,
});

test("a non-terminal run holding a park hook is reported suspended", async () => {
  const rows = await listRuns(factory, {
    listRuns: async () => [worldRun()],
    listHooks: async () => [{ runId: RUN_A, token: "github:pr:acme/api#41" }],
  });
  expect(rows[0]?.status).toBe("suspended");
});

const jobs =
  (dead: string[], live: string[] = []) =>
  async () => ({
    dead,
    live,
  });

test("a running run with a dead job and nothing in flight is stalled", async () => {
  const rows = await listRuns(factory, {
    listRuns: async () => [worldRun()],
    listHooks: async () => [],
    jobRunIds: jobs([RUN_A]),
    runsWithActiveStep: async () => [],
  });
  expect(rows[0]?.status).toBe("stalled");
});

test("a dead job beside a step still in flight is not a stall", async () => {
  const rows = await listRuns(factory, {
    listRuns: async () => [worldRun()],
    listHooks: async () => [],
    jobRunIds: jobs([RUN_A]),
    runsWithActiveStep: async () => [RUN_A],
  });
  expect(rows[0]?.status).toBe("running");
});

test("a healed run is not stalled: the dead row stays, but a live job replaced it", async () => {
  // A requeue and the World's own restart reconciliation each add a job
  // beside the dead one, which nothing ever clears — so a recovered run would
  // otherwise read stalled in every gap between its steps.
  const rows = await listRuns(factory, {
    listRuns: async () => [worldRun()],
    listHooks: async () => [],
    jobRunIds: jobs([RUN_A], [RUN_A]),
    runsWithActiveStep: async () => [],
  });
  expect(rows[0]?.status).toBe("running");
});

test("a run parked on a hook reads suspended even with a dead job", async () => {
  const rows = await listRuns(factory, {
    listRuns: async () => [worldRun()],
    listHooks: async () => [{ runId: RUN_A, token: "github:pr:acme/api#41" }],
    jobRunIds: jobs([RUN_A]),
    runsWithActiveStep: async () => [],
  });
  expect(rows[0]?.status).toBe("suspended");
});

test("a dead job left behind by a terminal run does not restate its status", async () => {
  const rows = await listRuns(factory, {
    listRuns: async () => [worldRun({ status: "completed" })],
    listHooks: async () => [],
    jobRunIds: jobs([RUN_A]),
    runsWithActiveStep: async () => [],
  });
  expect(rows[0]?.status).toBe("completed");
});

test("derivedRunStatus is the one thing `jigs ps` and the run route both read", () => {
  expect(derivedRunStatus("running", { parked: false, stalled: true })).toBe(
    "stalled",
  );
  expect(derivedRunStatus("running", { parked: true, stalled: true })).toBe(
    "suspended",
  );
  expect(derivedRunStatus("failed", { parked: false, stalled: true })).toBe(
    "failed",
  );
  expect(derivedRunStatus("pending", { parked: false, stalled: true })).toBe(
    "pending",
  );
});

test("a run holding only its ticket claim is still running, not suspended", async () => {
  const rows = await listRuns(factory, {
    listRuns: async () => [worldRun()],
    listHooks: async () => [
      { runId: RUN_A, token: `linear:ticket:${crypto.randomUUID()}` },
    ],
  });
  expect(rows[0]?.status).toBe("running");
});

test("a terminal run that still lists a hook keeps its own status", async () => {
  const rows = await listRuns(factory, {
    listRuns: async () => [worldRun({ status: "failed" })],
    listHooks: async () => [{ runId: RUN_A, token: "github:pr:acme/api#41" }],
  });
  expect(rows[0]?.status).toBe("failed");
});

test("runs are listed newest first", async () => {
  const rows = await listRuns(factory, {
    listRuns: async () => [
      worldRun({ createdAt: new Date("2026-08-26T09:00:00.000Z") }),
      worldRun({
        runId: RUN_B,
        createdAt: new Date("2026-08-26T11:00:00.000Z"),
      }),
    ],
    listHooks: async () => [],
  });
  expect(rows.map((row) => row.runId)).toEqual([RUN_B, RUN_A]);
});

test("a stamped workflow id is reported as the name its factory gave it", async () => {
  const rows = await listRuns(factory, {
    listRuns: async () => [worldRun()],
    listHooks: async () => [],
  });
  expect(rows[0]?.pipeline).toBe("stamped");
});

test("an unmapped workflow name is reported verbatim rather than guessed at", async () => {
  const rows = await listRuns(factory, {
    listRuns: async () => [worldRun({ workflowName: "workflow//./nope//x" })],
    listHooks: async () => [],
  });
  expect(rows[0]?.pipeline).toBe("workflow//./nope//x");
});

test("a run launched by hand reads as a manual trigger", async () => {
  const rows = await listRuns(factory, {
    listRuns: async () => [worldRun({ triggerId: crypto.randomUUID() })],
    listHooks: async () => [],
  });
  expect(rows[0]?.trigger).toBe("manual");
});

test("a scheduled run names its schedule, without the tick it fired on", async () => {
  const triggerId = scheduleTriggerId(
    "nightly-sweep",
    new Date("2026-08-26T03:00:00.400Z"),
  );
  expect(triggerId).toBe("schedule:nightly-sweep:2026-08-26T03:00:00Z");
  const rows = await listRuns(factory, {
    listRuns: async () => [worldRun({ triggerId })],
    listHooks: async () => [],
  });
  expect(rows[0]?.trigger).toBe("schedule:nightly-sweep");
});

test("a run whose inputs cannot be read reads as manual, like every other launch", async () => {
  const rows = await listRuns(factory, {
    listRuns: async () => [worldRun()],
    listHooks: async () => [],
  });
  expect(rows[0]?.trigger).toBe("manual");
});
