import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { PsRun } from "./ps.ts";
import { runEvents, watchRuns } from "./watch.ts";

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

const RUN = "wrun_01K3ANBZ4TQ8W9YV6H2E5C7DKM";
const AT = "2026-08-26T12:00:00.000Z";

const run = (over: Partial<PsRun> = {}): PsRun => ({
  runId: RUN,
  workflow: "deliver-feature",
  status: "running",
  outcome: null,
  trigger: "manual",
  ticket: "AGE-317",
  pullRequest: null,
  createdAt: "2026-08-26T11:30:00.000Z",
  lastActivityAt: "2026-08-26T11:59:00.000Z",
  steps: 1,
  lastStep: { name: "claimTicket", status: "completed", at: "2026-08-26T11:59:00.000Z" },
  suspended: false,
  suspensions: [],
  ...over,
});

const names = (events: ReturnType<typeof runEvents>) => events.map((event) => event.event);

test("a run nobody has seen before appeared", () => {
  const events = runEvents(undefined, run(), AT);
  expect(names(events)).toEqual(["appeared"]);
  expect(events[0]?.detail).toBe("AGE-317");
});

test("a run first seen already finished is loud, not just new", () => {
  const events = runEvents(undefined, run({ status: "failed", outcome: "failed" }), AT);
  expect(names(events)).toEqual(["appeared", "finished"]);
  expect(events[1]?.detail).toBe("failed — this run did not succeed");
});

test("a finished step and the park that follows it are two lines, in that order", () => {
  const before = run();
  const after = run({
    status: "suspended",
    suspended: true,
    steps: 2,
    lastStep: { name: "openPullRequest", status: "completed", at: "2026-08-26T12:00:00.000Z" },
    pullRequest: "acme/api#41",
    suspensions: [
      {
        token: "github:pr:acme/api#41",
        kind: "pull-request",
        reason: "waiting for an approving review and green CI on acme/api#41",
        url: "https://github.com/acme/api/pull/41",
      },
    ],
  });
  const events = runEvents(before, after, AT);
  expect(names(events)).toEqual(["step", "suspended"]);
  expect(events[0]?.detail).toBe("2 openPullRequest completed");
  expect(events[1]?.detail).toBe(
    "waiting for an approving review and green CI on acme/api#41 → https://github.com/acme/api/pull/41",
  );
});

test("a woken run resumes, and an unchanged one says nothing", () => {
  const parked = run({ status: "suspended", suspended: true });
  expect(names(runEvents(parked, run(), AT))).toEqual(["resumed"]);
  expect(runEvents(parked, parked, AT)).toEqual([]);
});

test("a run that gave up does not end like one that merged", () => {
  const merged = runEvents(run(), run({ status: "completed", outcome: "merged" }), AT);
  expect(names(merged)).toEqual(["finished"]);
  expect(merged[0]?.detail).toBe("merged");
  const limited = runEvents(run(), run({ status: "completed", outcome: "limit-reached" }), AT);
  expect(limited[0]?.detail).toBe("limit-reached — this run did not succeed");
});

const respond = (runs: PsRun[]) =>
  fetchMock.mockResolvedValueOnce(
    new Response(JSON.stringify({ runs, worktrees: [], schedules: [] })),
  );

const deps = () => ({
  out: (line: string) => lines.push(line),
  serviceUrl: "http://svc.test:8990",
  sleep: async () => {},
  now: () => new Date(AT),
});

test("the first poll states what is in play, then only what changed", async () => {
  respond([run(), run({ runId: "wrun_01K3ANC1P0R4S6TXZ8B3F5G7HJ", status: "completed" })]);
  respond([run({ status: "stalled" })]);
  await watchRuns(deps(), { polls: 2 });
  // The completed run is history, not something to follow.
  expect(lines).toEqual([`${AT} ${RUN} AGE-317 watching -`, `${AT} ${RUN} AGE-317 status stalled`]);
});

test("--json emits one JSON event per line", async () => {
  respond([run()]);
  await watchRuns(deps(), { polls: 1, json: true });
  expect(JSON.parse(lines[0] ?? "")).toMatchObject({
    event: "watching",
    runId: RUN,
    ticket: "AGE-317",
    status: "running",
  });
});

test("a service that goes away is one line, not the end of the watch", async () => {
  fetchMock.mockRejectedValueOnce(new Error("connection refused"));
  respond([run()]);
  await watchRuns(deps(), { polls: 2 });
  expect(lines[0]).toContain("unreachable");
  expect(lines[1]).toContain("watching");
});
