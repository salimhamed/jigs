import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { JigsError } from "../../errors.ts";
import { showLogs } from "./logs.ts";

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

const deps = () => ({
  out: (line: string) => lines.push(line),
  serviceUrl: "http://svc.test:8990",
});

const timeline = (body: unknown) =>
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body)));

test("logs prints the run's status, its suspensions, and the dashboard link", async () => {
  fetchMock.mockResolvedValueOnce(
    new Response(
      JSON.stringify({
        runId: RUN,
        status: "running",
        trigger: "manual",
        logs: DASHBOARD,
        suspensions: [
          {
            token: "github:pr:acme/api#41",
            reason: "awaiting pull request review",
          },
        ],
      }),
    ),
  );
  timeline({ steps: [], deadJobs: [] });
  await showLogs("AGE-317", deps());
  expect(fetchMock.mock.calls[0]?.[0]).toBe("http://svc.test:8990/api/runs/AGE-317");
  // The timeline is asked for by the run id the first call resolved, never by
  // the ref the operator typed.
  expect(fetchMock.mock.calls[1]?.[0]).toBe(`http://svc.test:8990/api/runs/${RUN}/steps`);
  expect(lines).toEqual([
    `run ${RUN}`,
    "status running",
    "trigger manual",
    "suspended on github:pr:acme/api#41: awaiting pull request review",
    // The service hosts the dashboard, so only it can name the port.
    DASHBOARD,
  ]);
});

test("a scheduled run names the schedule that fired it", async () => {
  fetchMock.mockResolvedValueOnce(
    new Response(
      JSON.stringify({
        runId: RUN,
        status: "running",
        trigger: "schedule:nightly-audit",
        logs: "",
      }),
    ),
  );
  timeline({ steps: [], deadJobs: [] });
  await showLogs(RUN, deps());
  expect(lines[2]).toBe("trigger schedule:nightly-audit");
});

test("a failed run's error is printed above the log pointer", async () => {
  fetchMock.mockResolvedValueOnce(
    new Response(
      JSON.stringify({
        runId: RUN,
        status: "failed",
        trigger: "manual",
        error: "ClaimConflictError: linear:ticket:… is already claimed",
        logs: DASHBOARD,
      }),
    ),
  );
  timeline({ steps: [], deadJobs: [] });
  await showLogs(RUN, deps());
  expect(lines).toEqual([
    `run ${RUN}`,
    "status failed",
    "trigger manual",
    "error ClaimConflictError: linear:ticket:… is already claimed",
    DASHBOARD,
  ]);
});

test("the step timeline reports a duration, a step still running, and its error", async () => {
  fetchMock.mockResolvedValueOnce(
    new Response(
      JSON.stringify({
        runId: RUN,
        status: "running",
        trigger: "manual",
        logs: "",
      }),
    ),
  );
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
  await showLogs(RUN, deps());
  expect(lines.slice(4)).toEqual([
    "",
    "STEP                             STATUS     ATTEMPT  STARTED                   TOOK     ERROR",
    "step//./steps/jigs//claimTicket  completed  1        2026-09-04T10:00:00.000Z  2.5s     ",
    "step//./steps/jigs//runAgent     running    2        2026-09-04T10:00:03.000Z  running  Error: the harness exited 1",
  ]);
});

test("a dead job is printed with its error's first line and a copy-pasteable requeue", async () => {
  fetchMock.mockResolvedValueOnce(
    new Response(
      JSON.stringify({
        runId: RUN,
        status: "running",
        trigger: "manual",
        logs: "",
      }),
    ),
  );
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
  await showLogs(RUN, deps());
  expect(lines.slice(4)).toEqual([
    "",
    "dead job 4128 (jigs:workflow) after 3 attempts: Queue execution failed (404): Not Found",
    "  requeue: select graphile_worker.reschedule_jobs(array[4128]::bigint[], run_at := now(), attempts := 0)",
  ]);
});

test("a timeline the service cannot read says so rather than reading as no steps", async () => {
  fetchMock.mockResolvedValueOnce(
    new Response(
      JSON.stringify({
        runId: RUN,
        status: "running",
        trigger: "manual",
        logs: "",
      }),
    ),
  );
  fetchMock.mockResolvedValueOnce(new Response("nope", { status: 503 }));
  await showLogs(RUN, deps());
  expect(lines).toEqual([
    `run ${RUN}`,
    "status running",
    "trigger manual",
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
