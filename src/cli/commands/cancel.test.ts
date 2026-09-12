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
const OTHER = "wrun_01K3ANC1P0R4S6TXZ8B3F5G7HJ";

const out = (line: string) => lines.push(line);
const deps = (over: Record<string, unknown> = {}) => ({
  out,
  serviceUrl: "http://svc.test:8990",
  ...over,
});

const respondLookup = (body: unknown, status = 200) =>
  fetchMock.mockResolvedValueOnce(
    new Response(JSON.stringify(body), { status }),
  );

const respondCancel = (releasedTokens: string[]) =>
  fetchMock.mockResolvedValueOnce(
    new Response(
      JSON.stringify({ runId: RUN, cancelled: true, releasedTokens }),
    ),
  );

const suspended = {
  runId: RUN,
  status: "running",
  suspended: true,
  suspensions: [
    {
      token: "github:pr:acme/api#41",
      reason: "awaiting pull request review",
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
  expect(fetchMock.mock.calls[1]?.[0]).toBe(
    `http://svc.test:8990/api/runs/${RUN}/cancel`,
  );
});

test("the released claim tokens are printed", async () => {
  respondLookup(suspended);
  respondCancel(["linear:ticket:AGE-317", "github:pr:acme/api#41"]);
  await cancelRun("AGE-317", deps());
  expect(lines).toEqual([
    `cancelled ${RUN}`,
    "released linear:ticket:AGE-317",
    "released github:pr:acme/api#41",
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
  expect(err?.message).toBe(
    "refusing to cancel an in-flight run without confirmation",
  );
  expect(err?.hint).toBe("re-run with --force");
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test("cancelling an already-cancelled run is refused with its status", async () => {
  respondLookup({ runId: RUN, status: "cancelled" });
  respondLookup({ error: `run ${RUN} is already cancelled` }, 409);
  const err = await failure(cancelRun(RUN, deps({ force: true })));
  expect(err?.message).toBe(`run ${RUN} is already cancelled`);
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

test("an ambiguous ref lists the candidates in the hint", async () => {
  respondLookup({ error: "ambiguous run ref", candidates: [RUN, OTHER] }, 409);
  const err = await failure(cancelRun("01K3AN", deps({ force: true })));
  expect(err?.message).toBe("run ref 01K3AN is ambiguous");
  expect(err?.hint).toContain(RUN);
  expect(err?.hint).toContain(OTHER);
  expect(err?.hint).toContain("use more characters");
});

test("a ref nothing holds is a not-found naming the ref", async () => {
  respondLookup({ error: "not found" }, 404);
  const err = await failure(cancelRun("AGE-999", deps({ force: true })));
  expect(err?.message).toBe("run AGE-999 not found");
});

test("an unreachable service surfaces the shared unreachable error", async () => {
  fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
  const err = await failure(cancelRun(RUN, deps({ force: true })));
  expect(err?.message).toContain("http://svc.test:8990");
});
