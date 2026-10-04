import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { JigsError } from "../../errors.ts";
import { stubService } from "../../test-fixtures.ts";
import { layoutProblems } from "../output-layout.ts";
import { cancelRun } from "./cancel.ts";

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

const out = (line: string) => lines.push(line);
const deps = (over: Record<string, unknown> = {}) => ({
  out,
  serviceUrl: "http://svc.test:8990",
  ...over,
});

const respondLookup = (body: unknown, status = 200) =>
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body), { status }));

const respondCancel = (releasedTokens: string[]) =>
  fetchMock.mockResolvedValueOnce(
    new Response(
      JSON.stringify({
        runId: RUN,
        cancelled: true,
        releasedTokens,
        retainedTokens: [],
        worktrees: [],
      }),
    ),
  );

const respondCancelWithWorktrees = (worktrees: string[]) =>
  fetchMock.mockResolvedValueOnce(
    new Response(
      JSON.stringify({
        runId: RUN,
        cancelled: true,
        releasedTokens: [],
        retainedTokens: [],
        worktrees,
      }),
    ),
  );

const parked = {
  runId: RUN,
  status: "running",
  suspensions: [
    {
      token: "github:pr:acme/api#41",
      kind: "pull-request",
      reason: "waiting for an approving review and green CI on acme/api#41",
      url: "https://github.com/acme/api/pull/41",
    },
  ],
};

const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (err: unknown) => err as JigsError,
  );

test("a parked run cancels with no confirmation prompt", async () => {
  respondLookup(parked);
  respondCancel(["github:pr:acme/api#41"]);
  const confirm = vi.fn();
  await cancelRun("AGE-317", deps({ confirm }));
  expect(confirm).not.toHaveBeenCalled();
  expect(fetchMock.mock.calls[1]?.[0]).toBe(`http://svc.test:8990/api/runs/${RUN}/cancel`);
});

test("released hooks are named by the ticket and pull request they held", async () => {
  respondLookup({
    ...parked,
    ticket: "AGE-317",
    resources: [
      {
        kind: "pull-request",
        identity: "Acme/API#41",
        url: "https://github.com/Acme/API/pull/41",
      },
    ],
  });
  respondCancel(["linear:ticket:0643cabe-d6c1-4e93-9e12-f57e9e01369b", "github:pr:acme/api#41"]);
  await cancelRun("AGE-317", deps());
  expect(lines).toEqual([
    `${RUN}  cancelled`,
    "  stopped claiming Linear ticket AGE-317",
    "  stopped watching pull request Acme/API#41",
  ]);
});

test("without a recorded ticket or pull request, the labels still avoid the tokens", async () => {
  respondLookup({ ...parked, ticket: null });
  respondCancel(["linear:ticket:0643cabe", "github:pr:acme/api#41"]);
  await cancelRun(RUN, deps());
  expect(lines).toEqual([
    `${RUN}  cancelled`,
    "  stopped claiming the Linear ticket (0643cabe)",
    "  stopped watching pull request acme/api#41",
  ]);
});

test("a minimum-retention hook is reported as still held", async () => {
  respondLookup({ ...parked, ticket: "AGE-317" });
  fetchMock.mockResolvedValueOnce(
    new Response(
      JSON.stringify({
        runId: RUN,
        cancelled: true,
        releasedTokens: [],
        retainedTokens: ["linear:ticket:uuid-1"],
        worktrees: [],
      }),
    ),
  );

  await cancelRun("AGE-317", deps());

  expect(lines).toEqual([`${RUN}  cancelled`, "  still claiming Linear ticket AGE-317"]);
});

test("cancel keeps and points each worktree at offline resource pruning", async () => {
  respondLookup(parked);
  respondCancelWithWorktrees(["/data/wt/one"]);

  await cancelRun("AGE-317", deps());

  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(lines).toEqual([
    `${RUN}  cancelled`,
    "  kept the worktree at /data/wt/one",
    "  to see what can be removed, run:",
    `    pnpm exec jigs resources prune --run ${RUN}`,
  ]);
});

test("an in-flight run asks before cancelling", async () => {
  respondLookup({ runId: RUN, status: "running", suspensions: [] });
  respondCancel([]);
  const confirm = vi.fn().mockResolvedValue(true);
  await cancelRun(RUN, deps({ confirm }));
  expect(confirm).toHaveBeenCalledWith(`cancel in-flight run ${RUN}?`);
});

test("declining leaves the run alone", async () => {
  respondLookup({ runId: RUN, status: "running", suspensions: [] });
  const confirm = vi.fn().mockResolvedValue(false);
  expect(await cancelRun(RUN, deps({ confirm }))).toBeNull();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(lines).toEqual([`did not cancel ${RUN}`]);
});

test("--force skips the prompt", async () => {
  respondLookup({ runId: RUN, status: "running", suspensions: [] });
  respondCancel([]);
  const confirm = vi.fn();
  await cancelRun(RUN, deps({ confirm, force: true }));
  expect(confirm).not.toHaveBeenCalled();
  expect(lines).toEqual([`${RUN}  cancelled`]);
});

test("no TTY and no --force refuses with a hint", async () => {
  respondLookup({ runId: RUN, status: "running", suspensions: [] });
  const err = await failure(cancelRun(RUN, deps()));
  expect(err?.message).toBe("refusing to cancel an in-flight run without confirmation");
  expect(err?.hint).toBe(`confirm with --force: \`pnpm exec jigs cancel ${RUN} --force\``);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test("cancelling an already-cancelled run is idempotent", async () => {
  respondLookup({ runId: RUN, status: "cancelled" });
  respondCancel([]);

  await expect(cancelRun(RUN, deps({ force: true }))).resolves.toMatchObject({ cancelled: true });
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(lines).toEqual([`${RUN}  cancelled`]);
});

test("a ref that is not a full run ID is a not-found pointing at jigs status", async () => {
  respondLookup({ error: "not found" }, 404);
  const err = await failure(cancelRun("AGE-999", deps({ force: true })));
  expect(err?.message).toBe("run AGE-999 not found");
  expect(err?.hint).toBe(
    "commands take a full run ID\nlist each run's ID and ticket: `pnpm exec jigs status`",
  );
});

test("an unreachable service surfaces the shared unreachable error", async () => {
  fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
  const err = await failure(cancelRun(RUN, deps({ force: true })));
  expect(err?.message).toContain("http://svc.test:8990");
});

// Every test's output, passing or failing, keeps to the shared layout.
afterEach(() => {
  expect(layoutProblems(lines)).toEqual([]);
});
