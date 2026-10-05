import { afterAll, expect, test, vi } from "vitest";
import { resumeHook } from "workflow/api";
import { HookNotFoundError } from "workflow/errors";
import { type WakeWaitingDeps, wakeAllWaitingRuns } from "./waiting-runs.ts";
import { clearWakes, lastWake } from "./wake.ts";

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

vi.mock("workflow/api", () => ({ resumeHook: vi.fn() }));
const resumeHookMock = vi.mocked(resumeHook);

const held = [
  { runId: "wrun_A", token: "github:pr:acme/api#1" },
  { runId: "wrun_B", token: "github:pr:acme/api#2" },
  { runId: "wrun_C", token: "linear:ticket:abc" },
  { runId: "wrun_D", token: "linear:ticket:def" },
  { runId: "wrun_D", token: "jigs:needs-human:def:comment-1" },
  // A halt marker from another run names no claim this run holds.
  { runId: "wrun_E", token: "jigs:needs-human:abc:comment-2" },
  { runId: "wrun_F", token: "slack:thread:C0C5EUZ7P9Q:1790723478.961719" },
];

function sweepDeps(overrides: WakeWaitingDeps = {}) {
  const resumed: string[] = [];
  const lines: string[] = [];
  const warnings: string[] = [];
  resumeHookMock.mockReset().mockImplementation(async (token) => {
    resumed.push(token as string);
    return { runId: held.find((hook) => hook.token === token)?.runId } as never;
  });
  return {
    resumed,
    lines,
    warnings,
    deps: {
      hooks: async () => held,
      busyRuns: async () => [],
      log: (line: string) => lines.push(line),
      warn: (line: string) => warnings.push(line),
      ...overrides,
    } satisfies WakeWaitingDeps,
  };
}

test("wakes every waiting run, but only the claim of a run halted on a human", async () => {
  clearWakes();
  const { deps, resumed, lines } = sweepDeps();
  expect(await wakeAllWaitingRuns(deps)).toEqual({
    held: 4,
    woken: 4,
    busy: 0,
    gone: 0,
    failed: 0,
  });
  // wrun_C holds its claim but is not halted, so waking it would only queue a
  // replay; the needs-human marker itself is never resumed.
  expect(resumed).toEqual([
    "github:pr:acme/api#1",
    "github:pr:acme/api#2",
    "linear:ticket:def",
    "slack:thread:C0C5EUZ7P9Q:1790723478.961719",
  ]);
  expect(lines).toEqual(["[hub] waiting runs: 4 held, 4 woken, 0 mid-turn, 0 gone, 0 failed"]);
  // `jigs status <run-id>` reads this back only for the run that was actually woken.
  expect(lastWake("github:pr:acme/api#1", "wrun_A")?.kind).toBe("hub fell behind");
  expect(lastWake("github:pr:acme/api#1", "wrun_B")).toBeUndefined();
});

test("a run in the middle of a turn is skipped rather than queued behind itself", async () => {
  const { deps, resumed } = sweepDeps({ busyRuns: async () => ["wrun_A", "wrun_D"] });
  expect(await wakeAllWaitingRuns(deps)).toMatchObject({ held: 4, woken: 2, busy: 2 });
  expect(resumed).toEqual(["github:pr:acme/api#2", "slack:thread:C0C5EUZ7P9Q:1790723478.961719"]);
});

test("a hook that disappeared is reported; any other failure is warned about", async () => {
  const { deps } = sweepDeps({ hooks: async () => held.slice(0, 2) });
  resumeHookMock.mockImplementation(async (token) => {
    if ((token as string).endsWith("#1")) throw new HookNotFoundError(token as string);
    throw new Error("postgres went away");
  });
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  expect(await wakeAllWaitingRuns(deps)).toEqual({
    held: 2,
    woken: 0,
    busy: 0,
    gone: 1,
    failed: 1,
  });
  expect(errors).toHaveBeenCalledOnce();
  expect(String(errors.mock.calls[0]?.[0])).toContain("postgres went away");
  errors.mockRestore();
});

test("a pass that cannot list hooks warns loudly and returns", async () => {
  const { deps, warnings } = sweepDeps({
    hooks: async () => {
      throw new Error("postgres is gone");
    },
  });
  expect(await wakeAllWaitingRuns(deps)).toEqual({
    held: 0,
    woken: 0,
    busy: 0,
    gone: 0,
    failed: 0,
  });
  expect(warnings[0]).toContain("could not wake the waiting runs");
  expect(warnings[0]).toContain("postgres is gone");
});
