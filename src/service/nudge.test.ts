import { afterAll, expect, test, vi } from "vitest";
import { HookNotFoundError } from "workflow/errors";
import {
  NUDGE_INTERVAL_MS,
  type NudgeDeps,
  nudgeDelay,
  nudgePullRequests,
  startPullRequestNudge,
} from "./nudge.ts";
import { clearWakes, lastWake } from "./wake-note.ts";

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

const held = [
  { runId: "wrun_A", token: "github:pr:acme/api#1" },
  { runId: "wrun_B", token: "github:pr:acme/api#2" },
  { runId: "wrun_C", token: "linear:ticket:abc" },
];

function sweepDeps(overrides: NudgeDeps = {}) {
  const resumed: string[] = [];
  const lines: string[] = [];
  const warnings: string[] = [];
  return {
    resumed,
    lines,
    warnings,
    deps: {
      hooks: async () => held,
      busyRuns: async () => [],
      resume: async (token: string) => {
        resumed.push(token);
      },
      log: (line: string) => lines.push(line),
      warn: (line: string) => warnings.push(line),
      ...overrides,
    } satisfies NudgeDeps,
  };
}

test("only pull request hooks are nudged, and the ticket claim is left alone", async () => {
  clearWakes();
  const { deps, resumed, lines } = sweepDeps();
  expect(await nudgePullRequests(deps)).toEqual({
    held: 2,
    nudged: 2,
    busy: 0,
    gone: 0,
    failed: 0,
  });
  expect(resumed).toEqual(["github:pr:acme/api#1", "github:pr:acme/api#2"]);
  expect(lines).toEqual(["[nudge] pull requests: 2 held, 2 nudged, 0 mid-turn, 0 gone, 0 failed"]);
  // `jigs status <run-id>` reads this back only for the run that was actually woken.
  expect(lastWake("github:pr:acme/api#1", "wrun_A")?.kind).toBe("nudge sweep");
  expect(lastWake("github:pr:acme/api#1", "wrun_B")).toBeUndefined();
});

test("a run in the middle of a turn is skipped rather than queued behind itself", async () => {
  const { deps, resumed } = sweepDeps({ busyRuns: async () => ["wrun_A"] });
  expect(await nudgePullRequests(deps)).toEqual({
    held: 2,
    nudged: 1,
    busy: 1,
    gone: 0,
    failed: 0,
  });
  expect(resumed).toEqual(["github:pr:acme/api#2"]);
});

test("a hook that disappeared is reported; any other failure is warned about", async () => {
  const { deps, warnings } = sweepDeps({
    resume: async (token: string) => {
      if (token.endsWith("#1")) throw new HookNotFoundError(token);
      throw new Error("postgres went away");
    },
  });
  expect(await nudgePullRequests(deps)).toEqual({
    held: 2,
    nudged: 0,
    busy: 0,
    gone: 1,
    failed: 1,
  });
  // A run whose hook is gone has moved on; a run whose resume failed has lost
  // its floor, and only the warning says so.
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain("postgres went away");
});

test("a sweep that cannot list hooks warns loudly and returns", async () => {
  const { deps, warnings } = sweepDeps({
    hooks: async () => {
      throw new Error("postgres is gone");
    },
  });
  expect(await nudgePullRequests(deps)).toEqual({
    held: 0,
    nudged: 0,
    busy: 0,
    gone: 0,
    failed: 0,
  });
  expect(warnings[0]).toContain("pull request sweep failed");
  expect(warnings[0]).toContain("postgres is gone");
});

test("nothing held still logs, so a silent service is not mistaken for a broken one", async () => {
  const { deps, lines } = sweepDeps({ hooks: async () => [] });
  expect(await nudgePullRequests(deps)).toEqual({
    held: 0,
    nudged: 0,
    busy: 0,
    gone: 0,
    failed: 0,
  });
  expect(lines).toEqual(["[nudge] pull requests: none held"]);
});

test("the jitter only ever makes a sweep early, and by at most thirty seconds", () => {
  expect(nudgeDelay(() => 0)).toBe(NUDGE_INTERVAL_MS);
  expect(nudgeDelay(() => 0.999999)).toBe(NUDGE_INTERVAL_MS - 29_999);
  for (const random of [0.1, 0.5, 0.75]) {
    const delay = nudgeDelay(() => random);
    expect(delay).toBeLessThanOrEqual(NUDGE_INTERVAL_MS);
    expect(delay).toBeGreaterThanOrEqual(NUDGE_INTERVAL_MS - 30_000);
  }
});

test("the timer sweeps again after each sweep, and stops when it is told to", async () => {
  const fires: Array<{ fire: () => void; ms: number }> = [];
  const { deps, resumed } = sweepDeps();
  const cancelled: number[] = [];
  const nudge = startPullRequestNudge({
    ...deps,
    random: () => 0,
    setTimer: (fire, ms) => {
      const at = fires.push({ fire, ms });
      return () => cancelled.push(at);
    },
  });

  expect(fires[0]?.ms).toBe(NUDGE_INTERVAL_MS);
  fires[0]?.fire();
  // The next sweep is scheduled only once this one has finished, so two can
  // never overlap.
  await vi.waitFor(() => expect(fires).toHaveLength(2));
  expect(resumed).toHaveLength(2);

  nudge.stop();
  expect(cancelled).toEqual([2]);
  fires[1]?.fire();
  await vi.waitFor(() => expect(resumed).toHaveLength(4));
  // A fire that was already in flight still sweeps, but schedules nothing new.
  expect(fires).toHaveLength(2);
});
