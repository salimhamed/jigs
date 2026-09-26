import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { RunListRun } from "./run-list.ts";
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

const run = (over: Partial<RunListRun> = {}): RunListRun => ({
  runId: RUN,
  workflow: "deliver-feature",
  status: "running",
  trigger: "manual",
  ticket: "AGE-317",
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
  const events = runEvents(undefined, run({ status: "failed" }), AT);
  expect(names(events)).toEqual(["appeared", "finished"]);
  expect(events[1]?.detail).toBe("failed");
});

test("a finished step and the park that follows it are two lines, in that order", () => {
  const before = run();
  const after = run({
    status: "suspended",
    suspended: true,
    steps: 2,
    lastStep: { name: "openPullRequest", status: "completed", at: "2026-08-26T12:00:00.000Z" },
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

test("a finished event carries only the run status", () => {
  const completed = runEvents(run(), run({ status: "completed" }), AT);
  expect(names(completed)).toEqual(["finished"]);
  expect(completed[0]?.detail).toBe("completed");
});

const respond = (runs: RunListRun[]) =>
  fetchMock.mockResolvedValueOnce(
    new Response(JSON.stringify({ runs, resources: [], schedules: [] })),
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
  expect(JSON.parse(lines[0] ?? "")).not.toHaveProperty("pullRequest");
});

test("a selected run is checked once and no unrelated run event leaks", async () => {
  const other = run({ runId: "wrun_01K3ANC1P0R4S6TXZ8B3F5G7HJ", ticket: "AGE-999" });
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(run())));
  respond([other, run()]);

  await watchRuns(deps(), { polls: 1, runId: RUN });

  expect(fetchMock.mock.calls[0]?.[0]).toBe(`http://svc.test:8990/api/runs/${RUN}`);
  expect(lines).toEqual([`${AT} ${RUN} AGE-317 watching -`]);
  expect(lines.join("\n")).not.toContain("AGE-999");
});

test("a selected watch keeps newline-delimited JSON", async () => {
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(run())));
  respond([run(), run({ runId: "wrun_01K3ANC1P0R4S6TXZ8B3F5G7HJ" })]);

  await watchRuns(deps(), { polls: 1, runId: RUN, json: true });

  expect(lines).toHaveLength(1);
  expect(JSON.parse(lines[0] ?? "")).toMatchObject({ runId: RUN, event: "watching" });
});

test("a ref that is not a full run ID fails before polling", async () => {
  fetchMock.mockResolvedValueOnce(
    new Response(JSON.stringify({ error: "not found" }), { status: 404 }),
  );
  await expect(watchRuns(deps(), { polls: 1, runId: "AGE-317" })).rejects.toMatchObject({
    message: "run AGE-317 not found",
    hint: expect.stringContaining("pnpm exec jigs status"),
  });
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test("a service that goes away is one line, not the end of the watch", async () => {
  fetchMock.mockRejectedValueOnce(new Error("connection refused"));
  respond([run()]);
  await watchRuns(deps(), { polls: 2 });
  expect(lines[0]).toContain("unreachable");
  expect(lines[1]).toContain("watching");
});
