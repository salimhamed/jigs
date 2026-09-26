import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { type RunListRun, showRuns } from "./run-list.ts";

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

const run = (over: Partial<RunListRun> = {}): RunListRun => ({
  runId: RUN,
  workflow: "deliver-feature",
  status: "running",
  trigger: "manual",
  ticket: null,
  createdAt: "2026-08-26T11:30:00.000Z",
  lastActivityAt: "2026-08-26T11:59:00.000Z",
  steps: 0,
  lastStep: null,
  suspensions: [],
  resources: [],
  ...over,
});

test("an empty service prints no runs", async () => {
  respond({ runs: [], schedules: [] });
  await showRuns(deps(), { now: NOW });
  expect(lines).toEqual(["no runs"]);
});

test("a parked run names its ticket and what it waits for", async () => {
  respond({
    runs: [
      run({
        ticket: "AGE-317",
        suspensions: [
          {
            token: "github:pr:acme/api#41",
            kind: "pull-request",
            reason: "waiting for an approving review and green CI on acme/api#41",
            url: "https://github.com/acme/api/pull/41",
          },
        ],
      }),
    ],
    schedules: [],
  });
  await showRuns(deps(), { now: NOW });
  expect(lines[0]).toBe(
    "RUN                              WORKFLOW         TICKET   STATUS   TRIGGER  AGE  ACTIVITY  WAITING",
  );
  expect(lines[1]).toBe(
    `${RUN}  deliver-feature  AGE-317  running  manual   30m  1m        waiting for an approving review and green CI on acme/api#41 → https://github.com/acme/api/pull/41`,
  );
});

test("runs are distinguished by SDK status", async () => {
  respond({
    runs: [
      run({ status: "failed" }),
      run({ runId: "wrun_01K3ANC1P0R4S6TXZ8B3F5G7HJ", status: "completed" }),
    ],
    schedules: [],
  });
  await showRuns(deps(), { now: NOW });
  expect(lines[1]).toContain(" failed ");
  expect(lines[2]).toContain(" completed ");
});

test("--json prints the service's answer verbatim, tables and all", async () => {
  const body = {
    runs: [run({ ticket: "AGE-317" })],
    schedules: [],
  };
  respond(body);
  await showRuns(deps(), { json: true, now: NOW });
  expect(lines).toHaveLength(1);
  expect(JSON.parse(lines[0] ?? "")).toEqual(body);
});

test("a scheduled run names the schedule that fired it", async () => {
  respond({
    runs: [run({ trigger: "schedule:nightly-sweep" })],
    schedules: [
      {
        name: "nightly-sweep",
        workflow: "deliver-feature",
        cron: "0 3 * * *",
        next: "2026-08-27T03:00:00.000Z",
        active: RUN,
      },
    ],
  });
  await showRuns(deps(), { now: NOW });
  expect(lines[1]).toContain("schedule:nightly-sweep");
  // The schedule table is its own section, after the runs.
  expect(lines[2]).toBe("");
  expect(lines[3]).toBe(
    "SCHEDULE       WORKFLOW         CRON       NEXT                      ACTIVE",
  );
  expect(lines[4]).toBe(
    `nightly-sweep  deliver-feature  0 3 * * *  2026-08-27T03:00:00.000Z  ${RUN}`,
  );
});

test("a declared schedule that has never fired shows dashes, not blanks", async () => {
  respond({
    runs: [],
    schedules: [
      {
        name: "weekly-audit",
        workflow: "audit",
        cron: "nonsense",
        next: null,
        active: null,
      },
    ],
  });
  await showRuns(deps(), { now: NOW });
  expect(lines[0]).toBe("no runs");
  expect(lines[3]).toBe("weekly-audit  audit     nonsense  -     -");
});

test("a resource release kept is shown with its reason", async () => {
  respond({
    runs: [
      run({
        status: "failed",
        resources: [
          {
            runId: RUN,
            kind: "worktree",
            identity: "/home/dev/worktrees/api/age-317",
            url: "file:///home/dev/worktrees/api/age-317",
            state: "kept",
            reason: "uncommitted work kept",
            updatedAt: "2026-09-04T10:00:00.000Z",
          },
          {
            runId: RUN,
            kind: "run-directory",
            identity: "released-history",
            url: "file:///scratch",
            state: "released",
            reason: "removed",
            updatedAt: "2026-09-04T10:00:00.000Z",
          },
        ],
      }),
    ],
    schedules: [],
  });
  await showRuns(deps(), { now: NOW });
  const resourceLine = lines.find((line) => line.includes("age-317"));
  expect(resourceLine).toContain("/home/dev/worktrees/api/age-317");
  expect(resourceLine).toContain("kept");
  expect(resourceLine).toContain("uncommitted work kept");
  expect(resourceLine).toContain(RUN);
  expect(lines.some((line) => line.startsWith("RESOURCE  "))).toBe(true);
  expect(lines.some((line) => line.includes("released-history"))).toBe(false);
  // A blank line separates the two tables.
  expect(lines[2]).toBe("");
});
