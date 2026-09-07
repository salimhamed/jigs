import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { showRuns } from "./ps.ts";

const fetchMock = vi.fn();
let lines: string[];

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  lines = [];
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const deps = () => ({
  out: (line: string) => lines.push(line),
  serviceUrl: "http://svc.test:8990",
});

const NOW = new Date("2026-08-26T12:00:00.000Z");
const RUN = "wrun_01K3ANBZ4TQ8W9YV6H2E5C7DKM";

const respond = (body: unknown) =>
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body)));

test("an empty service prints no runs", async () => {
  respond({ runs: [], worktrees: [], schedules: [] });
  await showRuns(deps(), NOW);
  expect(lines).toEqual(["no runs"]);
});

test("a suspended run renders as suspended, not running", async () => {
  respond({
    runs: [
      {
        runId: RUN,
        pipeline: "deliver-feature",
        status: "suspended",
        trigger: "manual",
        createdAt: "2026-08-26T11:30:00.000Z",
      },
    ],
    worktrees: [],
    schedules: [],
  });
  await showRuns(deps(), NOW);
  expect(lines).toEqual([
    "RUN                              PIPELINE         STATUS     TRIGGER  AGE",
    `${RUN}  deliver-feature  suspended  manual   30m`,
  ]);
});

test("a scheduled run names the schedule that fired it", async () => {
  respond({
    runs: [
      {
        runId: RUN,
        pipeline: "deliver-feature",
        status: "running",
        trigger: "schedule:nightly-sweep",
        createdAt: "2026-08-26T11:59:00.000Z",
      },
    ],
    worktrees: [],
    schedules: [
      {
        name: "nightly-sweep",
        pipeline: "deliver-feature",
        cron: "0 3 * * *",
        next: "2026-08-27T03:00:00.000Z",
        active: RUN,
      },
    ],
  });
  await showRuns(deps(), NOW);
  expect(lines[1]).toContain("schedule:nightly-sweep");
  // The schedule table is its own block, after the runs.
  expect(lines[2]).toBe("");
  expect(lines[3]).toBe(
    "SCHEDULE       PIPELINE         CRON       NEXT                      ACTIVE",
  );
  expect(lines[4]).toBe(
    `nightly-sweep  deliver-feature  0 3 * * *  2026-08-27T03:00:00.000Z  ${RUN}`,
  );
});

test("a declared schedule that has never fired shows dashes, not blanks", async () => {
  respond({
    runs: [],
    worktrees: [],
    schedules: [
      {
        name: "weekly-audit",
        pipeline: "audit",
        cron: "nonsense",
        next: null,
        active: null,
      },
    ],
  });
  await showRuns(deps(), NOW);
  expect(lines[0]).toBe("no runs");
  expect(lines[3]).toBe("weekly-audit  audit     nonsense  -     -");
});

test("a worktree the registry marks abandoned-dirty is shown, not filtered", async () => {
  respond({
    runs: [
      {
        runId: RUN,
        pipeline: "deliver-feature",
        status: "failed",
        trigger: "manual",
        createdAt: "2026-08-25T12:00:00.000Z",
      },
    ],
    worktrees: [
      {
        path: "/home/dev/worktrees/api/age-317",
        branch: "salimhamed/age-317",
        state: "abandoned-dirty",
        ownerRunId: RUN,
      },
    ],
    schedules: [],
  });
  await showRuns(deps(), NOW);
  const worktreeLine = lines.find((line) => line.includes("age-317"));
  expect(worktreeLine).toContain("/home/dev/worktrees/api/age-317");
  expect(worktreeLine).toContain("abandoned-dirty");
  expect(worktreeLine).toContain(RUN);
  expect(lines.some((line) => line.startsWith("WORKTREE  "))).toBe(true);
  // A blank line separates the two tables.
  expect(lines[2]).toBe("");
});
