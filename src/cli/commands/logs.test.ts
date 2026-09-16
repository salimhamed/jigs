import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { JigsError } from "../../errors.ts";
import { type LogsResult, showLogs } from "./logs.ts";

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
const DASHBOARD = `http://localhost:9090/run/${RUN}`;
const NOW = new Date("2026-09-04T10:10:00.000Z");

const deps = () => ({
  out: (line: string) => lines.push(line),
  serviceUrl: "http://svc.test:8990",
});

const result = (over: Partial<LogsResult> = {}): LogsResult => ({
  runId: RUN,
  status: "running",
  outcome: null,
  trigger: "manual",
  ticket: null,
  pullRequest: null,
  createdAt: "2026-09-04T10:00:00.000Z",
  lastActivityAt: "2026-09-04T10:09:00.000Z",
  steps: 0,
  lastStep: null,
  suspended: false,
  suspensions: [],
  logs: "",
  ...over,
});

const respond = (body: unknown) =>
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body)));

const timeline = (body: unknown) => respond(body);

test("logs says what the run waits for, where to act, and what was asked", async () => {
  respond(
    result({
      status: "suspended",
      ticket: "AGE-317",
      suspended: true,
      logs: DASHBOARD,
      suspensions: [
        {
          token: "jigs:needs-human:issue-1:comment-1",
          kind: "needs-human",
          reason: "waiting for a human reply on AGE-317",
          url: "https://linear.app/acme/issue/AGE-317#comment-comment-1",
          question: "Which binding?\nA. api",
        },
      ],
    }),
  );
  timeline({ steps: [], deadJobs: [] });
  await showLogs("AGE-317", deps(), { now: NOW });
  expect(fetchMock.mock.calls[0]?.[0]).toBe("http://svc.test:8990/api/runs/AGE-317");
  // The timeline is asked for by the run id the first call resolved, never by
  // the ref the operator typed.
  expect(fetchMock.mock.calls[1]?.[0]).toBe(`http://svc.test:8990/api/runs/${RUN}/steps`);
  expect(lines).toEqual([
    `run ${RUN}`,
    "status suspended",
    "trigger manual",
    "ticket AGE-317",
    "last activity 1m ago (2026-09-04T10:09:00.000Z)",
    "waiting for a human reply on AGE-317 → https://linear.app/acme/issue/AGE-317#comment-comment-1",
    "asked:",
    "  Which binding?",
    "  A. api",
    // The service hosts the dashboard, so only it can name the port.
    DASHBOARD,
  ]);
});

test("a run that hit its limit says so where a merged one says merged", async () => {
  respond(result({ status: "completed", outcome: "limit-reached", pullRequest: "acme/api#41" }));
  timeline({ steps: [], deadJobs: [] });
  await showLogs(RUN, deps(), { now: NOW });
  expect(lines[2]).toBe("outcome !limit-reached — this run did not succeed");
  expect(lines[4]).toBe("pull request acme/api#41");
});

test("a merged run's outcome is stated plainly", async () => {
  respond(result({ status: "completed", outcome: "merged" }));
  timeline({ steps: [], deadJobs: [] });
  await showLogs(RUN, deps(), { now: NOW });
  expect(lines[2]).toBe("outcome merged");
});

test("--json prints one document with the run, its suspensions and its timeline", async () => {
  respond(result({ ticket: "AGE-317", logs: DASHBOARD }));
  timeline({ steps: [{ name: "claimTicket", status: "completed" }], deadJobs: [] });
  await showLogs(RUN, deps(), { json: true, now: NOW });
  expect(lines).toHaveLength(1);
  const document = JSON.parse(lines[0] ?? "") as Record<string, unknown>;
  expect(document.ticket).toBe("AGE-317");
  expect(document.logs).toBe(DASHBOARD);
  expect(document.timeline).toEqual({
    steps: [{ name: "claimTicket", status: "completed" }],
    deadJobs: [],
  });
});

test("a scheduled run names the schedule that fired it", async () => {
  respond(result({ trigger: "schedule:nightly-audit" }));
  timeline({ steps: [], deadJobs: [] });
  await showLogs(RUN, deps(), { now: NOW });
  expect(lines[2]).toBe("trigger schedule:nightly-audit");
});

test("a failed run's error is printed above the log pointer", async () => {
  respond(
    result({
      status: "failed",
      outcome: "failed",
      error: "ClaimConflictError: linear:ticket:… is already claimed",
      logs: DASHBOARD,
    }),
  );
  timeline({ steps: [], deadJobs: [] });
  await showLogs(RUN, deps(), { now: NOW });
  expect(lines).toEqual([
    `run ${RUN}`,
    "status failed",
    "outcome !failed — this run did not succeed",
    "trigger manual",
    "last activity 1m ago (2026-09-04T10:09:00.000Z)",
    "error ClaimConflictError: linear:ticket:… is already claimed",
    DASHBOARD,
  ]);
});

test("the step timeline reports a duration, a step still running, and its error", async () => {
  respond(result());
  timeline({
    steps: [
      {
        name: "step//./steps/jigs//claimTicket",
        status: "completed",
        attempt: 1,
        startedAt: "2026-09-04T10:00:00.000Z",
        completedAt: "2026-09-04T10:00:02.500Z",
        error: null,
      },
      {
        name: "step//./steps/jigs//runAgent",
        status: "running",
        attempt: 2,
        startedAt: "2026-09-04T10:00:03.000Z",
        completedAt: null,
        error: "Error: the harness exited 1\n  at run (agent.ts:12)",
      },
    ],
    deadJobs: [],
  });
  await showLogs(RUN, deps(), { now: NOW });
  expect(lines.slice(5)).toEqual([
    "",
    "STEP                             STATUS     ATTEMPT  STARTED                   TOOK     ERROR",
    "step//./steps/jigs//claimTicket  completed  1        2026-09-04T10:00:00.000Z  2.5s     ",
    "step//./steps/jigs//runAgent     running    2        2026-09-04T10:00:03.000Z  running  Error: the harness exited 1",
  ]);
});

test("a dead job is printed with its error's first line and a copy-pasteable requeue", async () => {
  respond(result());
  timeline({
    steps: [],
    deadJobs: [
      {
        id: "4128",
        task: "jigs:workflow",
        attempts: 3,
        lastError: "Queue execution failed (404): Not Found\n  at executeMessageOverHttp",
        createdAt: "2026-09-04T10:00:00.000Z",
      },
    ],
  });
  await showLogs(RUN, deps(), { now: NOW });
  expect(lines.slice(5)).toEqual([
    "",
    "dead job 4128 (jigs:workflow) after 3 attempts: Queue execution failed (404): Not Found",
    "  requeue: select graphile_worker.reschedule_jobs(array[4128]::bigint[], run_at := now(), attempts := 0)",
  ]);
});

test("a timeline the service cannot read says so rather than reading as no steps", async () => {
  respond(result());
  fetchMock.mockResolvedValueOnce(new Response("nope", { status: 503 }));
  await showLogs(RUN, deps(), { now: NOW });
  expect(lines).toEqual([
    `run ${RUN}`,
    "status running",
    "trigger manual",
    "last activity 1m ago (2026-09-04T10:09:00.000Z)",
    "",
    "timeline unavailable: HTTP 503",
  ]);
});

test("an unresolvable ref fails before the pointer is printed", async () => {
  fetchMock.mockResolvedValueOnce(
    new Response(JSON.stringify({ error: "not found" }), { status: 404 }),
  );
  const err = await showLogs("AGE-999", deps()).then(
    () => null,
    (thrown: unknown) => thrown as JigsError,
  );
  expect(err?.message).toBe("run AGE-999 not found");
  expect(lines).toEqual([]);
});
