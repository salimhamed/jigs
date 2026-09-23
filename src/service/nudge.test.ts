import { afterAll, expect, test, vi } from "vitest";
import { HookNotFoundError } from "workflow/errors";
import { type NudgeDeps, nudgeDelay, nudgeProvider, startNudges } from "./nudge.ts";
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
  { runId: "wrun_D", token: "linear:ticket:def" },
  { runId: "wrun_D", token: "jigs:needs-human:def:comment-1" },
  // A halt marker from another run names no claim this run holds.
  { runId: "wrun_E", token: "jigs:needs-human:abc:comment-2" },
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

test("the pull request sweep nudges only pull request hooks", async () => {
  clearWakes();
  const { deps, resumed, lines } = sweepDeps();
  expect(await nudgeProvider("github", deps)).toEqual({
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
  expect(await nudgeProvider("github", deps)).toEqual({
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
  expect(await nudgeProvider("github", deps)).toEqual({
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
  expect(await nudgeProvider("github", deps)).toEqual({
    held: 0,
    nudged: 0,
    busy: 0,
    gone: 0,
    failed: 0,
  });
  expect(warnings[0]).toContain("pull requests sweep failed");
  expect(warnings[0]).toContain("postgres is gone");
});

test("nothing held still logs, so a silent service is not mistaken for a broken one", async () => {
  const { deps, lines } = sweepDeps({ hooks: async () => [] });
  expect(await nudgeProvider("github", deps)).toEqual({
    held: 0,
    nudged: 0,
    busy: 0,
    gone: 0,
    failed: 0,
  });
  expect(lines).toEqual(["[nudge] pull requests: none held"]);
});

test("the ticket sweep nudges only the claim of a run halted on a human", async () => {
  clearWakes();
  const { deps, resumed, lines } = sweepDeps();
  expect(await nudgeProvider("linear", deps)).toEqual({
    held: 1,
    nudged: 1,
    busy: 0,
    gone: 0,
    failed: 0,
  });
  // wrun_C holds its claim but is not halted, so waking it would only queue a
  // replay; the needs-human marker itself is never resumed.
  expect(resumed).toEqual(["linear:ticket:def"]);
  expect(lines).toEqual(["[nudge] tickets: 1 held, 1 nudged, 0 mid-turn, 0 gone, 0 failed"]);
  expect(lastWake("linear:ticket:def", "wrun_D")?.kind).toBe("nudge sweep");
});

test("a halted run in the middle of a turn is skipped by the ticket sweep too", async () => {
  const { deps, resumed } = sweepDeps({ busyRuns: async () => ["wrun_D"] });
  expect((await nudgeProvider("linear", deps)).busy).toBe(1);
  expect(resumed).toEqual([]);
});

test("the jitter only ever makes a sweep early, and by at most a tenth of the interval", () => {
  expect(nudgeDelay(300, () => 0)).toBe(300_000);
  expect(nudgeDelay(300, () => 0.999999)).toBe(300_000 - 29_999);
  expect(nudgeDelay(30, () => 0.999999)).toBe(30_000 - 2_999);
  for (const random of [0.1, 0.5, 0.75]) {
    const delay = nudgeDelay(600, () => random);
    expect(delay).toBeLessThanOrEqual(600_000);
    expect(delay).toBeGreaterThanOrEqual(600_000 - 60_000);
  }
});

test("each provider sweeps on its own interval, again after each sweep, until stopped", async () => {
  const fires: Array<{ fire: () => void; ms: number }> = [];
  const { deps, resumed } = sweepDeps();
  const cancelled: number[] = [];
  const nudge = startNudges(
    { github: 60, linear: 120 },
    {
      ...deps,
      random: () => 0,
      setTimer: (fire, ms) => {
        const at = fires.push({ fire, ms });
        return () => cancelled.push(at);
      },
    },
  );

  expect(fires.map((timer) => timer.ms)).toEqual([60_000, 120_000]);
  fires[0]?.fire();
  // The next sweep is scheduled only once this one has finished, so two can
  // never overlap.
  await vi.waitFor(() => expect(fires).toHaveLength(3));
  expect(fires[2]?.ms).toBe(60_000);
  expect(resumed).toEqual(["github:pr:acme/api#1", "github:pr:acme/api#2"]);
  fires[1]?.fire();
  await vi.waitFor(() => expect(fires).toHaveLength(4));
  expect(fires[3]?.ms).toBe(120_000);
  expect(resumed.at(-1)).toBe("linear:ticket:def");

  nudge.stop();
  expect(cancelled.sort()).toEqual([3, 4]);
  fires[2]?.fire();
  await vi.waitFor(() => expect(resumed).toHaveLength(5));
  // A fire that was already in flight still sweeps, but schedules nothing new.
  expect(fires).toHaveLength(4);
});
