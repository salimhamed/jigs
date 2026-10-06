import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { JigsError } from "../../errors.ts";
import { describeSuspension } from "../../run-suspension.ts";
import { stubService } from "../../test-fixtures.ts";
import { slackThreadToken } from "../../workflow/slack/thread-token.ts";
import { layoutProblems } from "../output-layout.ts";
import { type StatusResult, showRunStatus } from "./status.ts";

const fetchMock = vi.fn();
let lines: string[];

beforeEach(() => {
  stubService(fetchMock);
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

const result = (over: Partial<StatusResult> = {}): StatusResult => ({
  runId: RUN,
  status: "running",
  trigger: "manual",
  source: null,
  ticket: null,
  createdAt: "2026-09-04T10:00:00.000Z",
  lastActivityAt: "2026-09-04T10:09:00.000Z",
  steps: 0,
  lastStep: null,
  suspensions: [],
  dashboard: "",
  resources: [],
  claim: null,
  ...over,
});

const respond = (body: unknown) =>
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body)));

test("status says what the run waits for, where to act, and what was asked", async () => {
  respond(
    result({
      status: "running",
      ticket: "AGE-317",
      dashboard: DASHBOARD,
      suspensions: [
        {
          token: "jigs:needs-human:acme:issue-1:comment-1",
          kind: "needs-human",
          reason: "waiting for a human reply on AGE-317",
          url: "https://linear.app/acme/issue/AGE-317#comment-comment-1",
          question: "Which binding?\nA. api",
        },
      ],
    }),
  );
  respond({ steps: [], deadJobs: [] });
  await showRunStatus("AGE-317", deps(), { now: NOW });
  expect(fetchMock.mock.calls[0]?.[0]).toBe("http://svc.test:8990/api/runs/AGE-317");
  // The timeline is asked for by the run id the first call resolved, never by
  // the ref the operator typed.
  expect(fetchMock.mock.calls[1]?.[0]).toBe(`http://svc.test:8990/api/runs/${RUN}/steps`);
  expect(lines).toEqual([
    `${RUN}  running`,
    "  trigger        manual",
    "  ticket         AGE-317",
    "  last activity  1m ago (2026-09-04T10:09:00.000Z)",
    "  resources      none",
    // The service hosts the dashboard, so only it can name the port.
    `  dashboard      ${DASHBOARD}`,
    "",
    "Waiting",
    "  waiting for a human reply on AGE-317 → https://linear.app/acme/issue/AGE-317#comment-comment-1",
    "  asked:",
    "    Which binding?",
    "    A. api",
  ]);
});

test("a run waiting on a Slack thread says which thread", async () => {
  const suspension = describeSuspension(slackThreadToken("acme", "C0123ABCD", "1790723244.335019"));
  respond(result({ suspensions: suspension === null ? [] : [suspension] }));
  respond({ steps: [], deadJobs: [] });
  await showRunStatus(RUN, deps(), { now: NOW });
  expect(lines).toContain(
    "  waiting for a reply in the Slack thread 1790723244.335019 in C0123ABCD",
  );
});

test("a trigger's run names the Slack message it was started for", async () => {
  respond(
    result({
      trigger: "trigger:answers",
      source: { kind: "slack", label: "slack C0123ABCD 1790723244.335019" },
    }),
  );
  respond({ steps: [], deadJobs: [] });
  await showRunStatus(RUN, deps(), { now: NOW });
  expect(lines.slice(1, 3)).toEqual([
    "  trigger        trigger:answers",
    "  source         slack C0123ABCD 1790723244.335019",
  ]);
});

test("a failed run prints its status without a pull request header", async () => {
  respond(result({ status: "failed" }));
  respond({ steps: [], deadJobs: [] });
  await showRunStatus(RUN, deps(), { now: NOW });
  expect(lines[0]).toBe(`${RUN}  failed`);
  expect(lines.some((line) => line.startsWith("pull request "))).toBe(false);
});

test("each resource shows its state and the reason release recorded", async () => {
  const record = { runId: RUN, updatedAt: "2026-09-04T10:09:00.000Z" };
  respond(
    result({
      status: "completed",
      resources: [
        {
          ...record,
          kind: "worktree",
          identity: "/w/age-1",
          url: "file:///w/age-1",
          state: "kept",
          reason: "uncommitted work\nkept",
        },
        {
          ...record,
          kind: "run-directory",
          identity: RUN,
          url: "file:///s/run",
          state: "released",
          reason: "removed",
        },
      ],
    }),
  );
  respond({ steps: [], deadJobs: [] });

  await showRunStatus(RUN, deps(), { now: NOW });

  expect(lines.slice(3)).toEqual([
    "",
    "Resources",
    "  KIND           STATE     RESOURCE",
    "  worktree       kept      /w/age-1",
    "                           uncommitted work\\nkept",
    `  run-directory  released  ${RUN}`,
    "                           /s/run",
    "                           removed",
  ]);
});

test("status prints live pull-request gate state under its suspension", async () => {
  respond(
    result({
      status: "running",
      suspensions: [
        {
          token: "github:pr:acme:acme/api#41",
          kind: "pull-request",
          reason: "waiting for an approving review and green CI on acme/api#41",
          headSha: "1234567",
          ci: "red",
          approval: "approved",
          draft: false,
          mergeState: "blocked",
          blocker: "CI is red",
          lastWake: { kind: "github check_suite", at: "2026-09-04T10:08:00.000Z" },
        },
      ],
    }),
  );
  respond({ steps: [], deadJobs: [] });
  await showRunStatus(RUN, deps(), { now: NOW });
  expect(lines.slice(4)).toEqual([
    "",
    "Waiting",
    "  waiting for an approving review and green CI on acme/api#41",
    "    head sha         1234567",
    "    CI               red",
    "    approval         approved",
    "    draft            no",
    "    mergeable state  blocked",
    "    blocker          CI is red",
    "    last wake        github check_suite, 2m ago (2026-09-04T10:08:00.000Z)",
  ]);
});

test("status prints the last wake of a human and a Slack-thread wait", async () => {
  respond(
    result({
      status: "running",
      suspensions: [
        {
          token: "jigs:needs-human:acme:issue-1:comment-1",
          kind: "needs-human",
          reason: "waiting for a human to answer on AGE-1",
          lastWake: { kind: "linear Comment", at: "2026-09-04T10:08:00.000Z" },
        },
        {
          token: "slack:thread:acme:C0C5EUZ7P9Q:1790723478.961719",
          kind: "slack-thread",
          reason: "waiting for a reply in a Slack thread",
          lastWake: { kind: "slack reply", at: "2026-09-04T10:08:00.000Z" },
        },
      ],
    }),
  );
  respond({ steps: [], deadJobs: [] });
  await showRunStatus(RUN, deps(), { now: NOW });
  expect(lines.slice(4)).toEqual([
    "",
    "Waiting",
    "  waiting for a human to answer on AGE-1",
    "    last wake  linear Comment, 2m ago (2026-09-04T10:08:00.000Z)",
    "  waiting for a reply in a Slack thread",
    "    last wake  slack reply, 2m ago (2026-09-04T10:08:00.000Z)",
  ]);
});

test("a pull request GitHub could not be asked about prints as it always did", async () => {
  respond(
    result({
      status: "running",
      suspensions: [
        {
          token: "github:pr:acme:acme/api#41",
          kind: "pull-request",
          reason: "waiting for an approving review and green CI on acme/api#41",
        },
      ],
    }),
  );
  respond({ steps: [], deadJobs: [] });
  await showRunStatus(RUN, deps(), { now: NOW });
  expect(lines.slice(4)).toEqual([
    "",
    "Waiting",
    "  waiting for an approving review and green CI on acme/api#41",
  ]);
});

test("--json prints one document with the run, its suspensions and its timeline", async () => {
  respond(result({ ticket: "AGE-317", dashboard: DASHBOARD, returnValue: { status: "gave-up" } }));
  respond({ steps: [{ name: "claimTicket", status: "completed" }], deadJobs: [] });
  await showRunStatus(RUN, deps(), { json: true, now: NOW });
  expect(lines).toHaveLength(1);
  const document = JSON.parse(lines[0] ?? "") as Record<string, unknown>;
  expect(document.ticket).toBe("AGE-317");
  expect(document.dashboard).toBe(DASHBOARD);
  expect(document.returnValue).toEqual({ status: "gave-up" });
  expect(document.resources).toEqual([]);
  expect(document.timeline).toEqual({
    steps: [{ name: "claimTicket", status: "completed" }],
    deadJobs: [],
  });
  expect(document).not.toHaveProperty("pullRequest");
});

test("a scheduled run names the schedule that fired it", async () => {
  respond(result({ trigger: "schedule:nightly-audit" }));
  respond({ steps: [], deadJobs: [] });
  await showRunStatus(RUN, deps(), { now: NOW });
  expect(lines[1]).toBe("  trigger        schedule:nightly-audit");
});

test("a failed run's error is printed above the log pointer", async () => {
  respond(
    result({
      status: "failed",
      error: "ClaimConflictError: linear:ticket:… is already claimed",
      dashboard: DASHBOARD,
    }),
  );
  respond({ steps: [], deadJobs: [] });
  await showRunStatus(RUN, deps(), { now: NOW });
  expect(lines).toEqual([
    `${RUN}  failed`,
    "  trigger        manual",
    "  last activity  1m ago (2026-09-04T10:09:00.000Z)",
    "  error          ClaimConflictError: linear:ticket:… is already claimed",
    "  resources      none",
    `  dashboard      ${DASHBOARD}`,
  ]);
});

test("a multi-line run error stays on its row in the facts block", async () => {
  respond(result({ status: "failed", error: "Error: boom\n  at run (agent.ts:12)" }));
  respond({ steps: [], deadJobs: [] });
  await showRunStatus(RUN, deps(), { now: NOW });
  expect(lines[3]).toBe("  error          Error: boom\\n  at run (agent.ts:12)");
});

test("a completed run prints a compact object result", async () => {
  respond(
    result({
      status: "completed",
      returnValue: {
        status: "gave-up",
        attempts: 3,
        retryable: false,
        detail: { reason: "budget exhausted" },
        findings: ["one", "two"],
        note: null,
      },
    }),
  );
  respond({ steps: [], deadJobs: [] });
  await showRunStatus(RUN, deps(), { now: NOW });
  expect(lines.slice(4)).toEqual([
    "",
    "Result",
    "  status     gave-up",
    "  attempts   3",
    "  retryable  false",
    "  detail     {…}",
    "  findings   [2 items]",
    "  note       null",
  ]);
});

test("resources are listed independently of the workflow return shape", async () => {
  respond(
    result({
      status: "completed",
      returnValue: "done",
      resources: [
        {
          runId: RUN,
          kind: "pull-request",
          identity: "acme/api#41",
          url: "https://github.com/acme/api/pull/41",
          state: "live",
          reason: null,
          updatedAt: "2026-09-04T10:09:00.000Z",
        },
        {
          runId: RUN,
          kind: "custom-report",
          identity: "quarterly\nsummary",
          url: "https://example.test/report\nunsafe",
          state: "live",
          reason: null,
          updatedAt: "2026-09-04T10:09:00.000Z",
        },
      ],
    }),
  );
  respond({ steps: [], deadJobs: [] });
  await showRunStatus(RUN, deps(), { now: NOW });
  expect(lines.slice(3)).toEqual([
    "  result         done",
    "",
    "Resources",
    "  KIND           STATE  RESOURCE",
    "  pull-request   live   acme/api#41",
    "                        https://github.com/acme/api/pull/41",
    "  custom-report  live   quarterly\\nsummary",
    "                        https://example.test/report\\nunsafe",
  ]);
});

test("result keys and scalar values stay on one terminal line", async () => {
  respond(
    result({
      status: "completed",
      returnValue: {
        "multi\nline": "one\r\ntwo\rthree\u2028four\u2029five",
      },
    }),
  );
  respond({ steps: [], deadJobs: [] });
  await showRunStatus(RUN, deps(), { now: NOW });
  expect(lines.slice(5, 7)).toEqual([
    "Result",
    "  multi\\nline  one\\ntwo\\rthree\\u2028four\\u2029five",
  ]);
});

test("a multiline scalar result stays on the result line", async () => {
  respond(result({ status: "completed", returnValue: "one\ntwo" }));
  respond({ steps: [], deadJobs: [] });
  await showRunStatus(RUN, deps(), { now: NOW });
  expect(lines[4]).toBe("  result         one\\ntwo");
});

test.each([
  ["a string", "gave-up", "  result         gave-up"],
  ["a number", 42, "  result         42"],
])("a completed run prints %s result on the result line", async (_label, returnValue, expected) => {
  respond(result({ status: "completed", returnValue }));
  respond({ steps: [], deadJobs: [] });
  await showRunStatus(RUN, deps(), { now: NOW });
  expect(lines[4]).toBe(expected);
});

test.each([
  ["undefined", undefined],
  ["null", null],
])("a completed run with %s for its result prints nothing new", async (_label, returnValue) => {
  respond(result({ status: "completed", returnValue }));
  respond({ steps: [], deadJobs: [] });
  await showRunStatus(RUN, deps(), { now: NOW });
  expect(lines).toEqual([
    `${RUN}  completed`,
    "  trigger        manual",
    "  last activity  1m ago (2026-09-04T10:09:00.000Z)",
    "  resources      none",
  ]);
});

test("an object result is capped and reports its omitted keys", async () => {
  respond(
    result({
      status: "completed",
      returnValue: Object.fromEntries(
        Array.from({ length: 15 }, (_, index) => [`key${index + 1}`, index + 1]),
      ),
    }),
  );
  respond({ steps: [], deadJobs: [] });
  await showRunStatus(RUN, deps(), { now: NOW });
  expect(lines.slice(5)).toEqual([
    "Result",
    ...Array.from({ length: 12 }, (_, index) => `  ${`key${index + 1}`.padEnd(5)}  ${index + 1}`),
    "  … 3 more keys",
  ]);
});

test("the step timeline reports a duration, a step still running, and its error", async () => {
  respond(result());
  respond({
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
  await showRunStatus(RUN, deps(), { now: NOW });
  expect(lines.slice(4)).toEqual([
    "",
    "Steps",
    "  STEP                             STATUS     ATTEMPT  STARTED                   TOOK     ERROR",
    "  step//./steps/jigs//claimTicket  completed  1        2026-09-04T10:00:00.000Z  2.5s",
    "  step//./steps/jigs//runAgent     running    2        2026-09-04T10:00:03.000Z  running  Error: the harness exited 1",
  ]);
});

test("a dead job is printed with its error's first line and a copy-pasteable requeue", async () => {
  respond(result());
  respond({
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
  await showRunStatus(RUN, deps(), { now: NOW });
  expect(lines.slice(4)).toEqual([
    "",
    "Dead jobs",
    "  job 4128 (jigs:workflow) gave up after 3 attempts: Queue execution failed (404): Not Found",
    "  to requeue it, run in the World database:",
    "    select graphile_worker.reschedule_jobs(array[4128]::bigint[], run_at := now(), attempts := 0)",
  ]);
});

test("a timeline the service cannot read says so rather than reading as no steps", async () => {
  respond(result());
  fetchMock.mockResolvedValueOnce(new Response("nope", { status: 503 }));
  await showRunStatus(RUN, deps(), { now: NOW });
  expect(lines).toEqual([
    `${RUN}  running`,
    "  trigger        manual",
    "  last activity  1m ago (2026-09-04T10:09:00.000Z)",
    "  resources      none",
    "",
    "timeline unavailable: HTTP 503",
  ]);
});

test("a ref that is not a full run ID fails before the pointer is printed", async () => {
  fetchMock.mockResolvedValueOnce(
    new Response(JSON.stringify({ error: "not found" }), { status: 404 }),
  );
  const err = await showRunStatus("AGE-999", deps()).then(
    () => null,
    (thrown: unknown) => thrown as JigsError,
  );
  expect(err?.message).toBe("run AGE-999 not found");
  expect(err?.hint).toContain("list each run's ID and ticket: `pnpm exec jigs status`");
  expect(lines).toEqual([]);
});

// Every test's output, passing or failing, keeps to the shared layout.
afterEach(() => {
  expect(layoutProblems(lines)).toEqual([]);
});
