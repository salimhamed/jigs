import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { JigsError } from "../../errors.ts";
import { cancelRun } from "./cancel.ts";

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

const suspended = {
  runId: RUN,
  status: "suspended",
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

test("a suspended run cancels with no confirmation prompt", async () => {
  respondLookup(suspended);
  respondCancel(["github:pr:acme/api#41"]);
  const confirm = vi.fn();
  await cancelRun("AGE-317", deps({ confirm }));
  expect(confirm).not.toHaveBeenCalled();
  expect(fetchMock.mock.calls[1]?.[0]).toBe(`http://svc.test:8990/api/runs/${RUN}/cancel`);
});

test("the released claim tokens are printed without promising queue cleanup", async () => {
  respondLookup(suspended);
  respondCancel(["linear:ticket:AGE-317", "github:pr:acme/api#41"]);
  await cancelRun("AGE-317", deps());
  expect(lines).toEqual([
    `cancelled ${RUN}`,
    "released linear:ticket:AGE-317",
    "released github:pr:acme/api#41",
  ]);
});

test("a minimum-retention hook is reported as retained", async () => {
  respondLookup(suspended);
  fetchMock.mockResolvedValueOnce(
    new Response(
      JSON.stringify({
        runId: RUN,
        cancelled: true,
        releasedTokens: [],
        retainedTokens: ["linear:ticket:AGE-317"],
        worktrees: [],
      }),
    ),
  );

  await cancelRun("AGE-317", deps());

  expect(lines).toEqual([`cancelled ${RUN}`, "retained linear:ticket:AGE-317"]);
});

test("cancel keeps and points each worktree at offline resource pruning", async () => {
  respondLookup(suspended);
  respondCancelWithWorktrees(["/data/wt/one"]);

  await cancelRun("AGE-317", deps());

  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(lines.at(-1)).toBe(
    `worktree kept at /data/wt/one — pnpm exec jigs resources prune --run ${RUN} to review`,
  );
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
  expect(lines).toEqual(["left alone"]);
});

test("--force skips the prompt", async () => {
  respondLookup({ runId: RUN, status: "running", suspensions: [] });
  respondCancel([]);
  const confirm = vi.fn();
  await cancelRun(RUN, deps({ confirm, force: true }));
  expect(confirm).not.toHaveBeenCalled();
  expect(lines).toEqual([`cancelled ${RUN}`]);
});

test("no TTY and no --force refuses with a hint", async () => {
  respondLookup({ runId: RUN, status: "running", suspensions: [] });
  const err = await failure(cancelRun(RUN, deps()));
  expect(err?.message).toBe("refusing to cancel an in-flight run without confirmation");
  expect(err?.hint).toBe("re-run with --force");
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test("cancelling an already-cancelled run is idempotent", async () => {
  respondLookup({ runId: RUN, status: "cancelled" });
  respondCancel([]);

  await expect(cancelRun(RUN, deps({ force: true }))).resolves.toMatchObject({ cancelled: true });
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(lines).toEqual([`cancelled ${RUN}`]);
});

test("a ref that is not a full run ID is a not-found pointing at jigs status", async () => {
  respondLookup({ error: "not found" }, 404);
  const err = await failure(cancelRun("AGE-999", deps({ force: true })));
  expect(err?.message).toBe("run AGE-999 not found");
  expect(err?.hint).toBe(
    "commands take a full run ID: pnpm exec jigs status lists each run's ID under RUN and its ticket under TICKET",
  );
});

test("an unreachable service surfaces the shared unreachable error", async () => {
  fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
  const err = await failure(cancelRun(RUN, deps({ force: true })));
  expect(err?.message).toContain("http://svc.test:8990");
});
