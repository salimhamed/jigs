import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { CliError } from "../errors.ts";
import { sweepWorktrees } from "./sweep.ts";

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

const respond = (body: unknown) =>
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body)));

const entry = (overrides: Record<string, unknown>) => ({
  path: "/data/wt/feat",
  branch: "feat",
  state: "abandoned",
  eligible: true,
  requiresForce: false,
  reason: "the owning run is terminal and the tree is clean",
  ...overrides,
});

test("sweep posts the clean and force flags and prints one line per entry", async () => {
  respond({
    entries: [
      entry({ ownerRunId: "run_a" }),
      entry({
        path: "/data/wt/held",
        state: "held",
        eligible: false,
        ownerRunId: "run_b",
        reason: "the owning run is still live or suspended",
      }),
    ],
    removed: ["/data/wt/feat"],
    removedDirs: [],
  });
  const result = await sweepWorktrees(deps(), { clean: true, force: true });
  expect(fetchMock).toHaveBeenCalledWith(
    "http://svc.test:8990/api/worktrees/sweep",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clean: true, force: true }),
    },
  );
  expect(result.removed).toEqual(["/data/wt/feat"]);
  expect(lines[0]).toContain("abandoned");
  expect(lines[0]).toContain("run_a");
  expect(lines[1]).toContain("held");
  expect(lines.at(-1)).toBe("1 removed, 1 held, 0 need --force");
});

test("a report run posts clean:false", async () => {
  respond({ entries: [], removed: [], removedDirs: [] });
  await sweepWorktrees(deps());
  expect(fetchMock.mock.calls[0]?.[1].body).toBe(
    JSON.stringify({ clean: false, force: false }),
  );
  expect(lines).toEqual(["no worktrees", "0 removed, 0 held, 0 need --force"]);
});

test("the summary counts entries that would need --force", async () => {
  respond({
    entries: [
      entry({
        path: "/data/wt/dirty",
        state: "abandoned-dirty",
        requiresForce: true,
        ownerRunId: "run_c",
      }),
    ],
    removed: [],
    removedDirs: [],
  });
  await sweepWorktrees(deps(), { clean: true });
  expect(lines.at(-1)).toBe("0 removed, 0 held, 1 need --force");
});

test("--force without --clean is refused with a hint", async () => {
  const failure = await sweepWorktrees(deps(), { force: true }).then(
    () => null,
    (err: unknown) => err,
  );
  expect(failure).toBeInstanceOf(CliError);
  expect((failure as CliError).message).toBe(
    "--force only applies with --clean",
  );
  expect((failure as CliError).hint).toContain("add --clean");
  expect(fetchMock).not.toHaveBeenCalled();
});

test("an unreachable service raises the service-not-running CliError", async () => {
  fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
  const failure = await sweepWorktrees(deps()).then(
    () => null,
    (err: unknown) => err,
  );
  expect(failure).toBeInstanceOf(CliError);
  expect((failure as CliError).message).toContain("http://svc.test:8990");
  expect((failure as CliError).hint).toContain("is the jigs service running?");
});

test("a trailing slash on the service URL does not break the sweep route", async () => {
  respond({ entries: [], removed: [], removedDirs: [] });
  await sweepWorktrees({
    out: (line: string) => lines.push(line),
    serviceUrl: "http://svc.test:8990/",
  });
  expect(fetchMock.mock.calls[0]?.[0]).toBe(
    "http://svc.test:8990/api/worktrees/sweep",
  );
});

test("a bare sweep report names --clean when eligible trees exist", async () => {
  respond({
    entries: [entry({ ownerRunId: "run_a" })],
    removed: [],
    removedDirs: [],
  });
  await sweepWorktrees(deps());
  expect(lines.at(-1)).toBe(
    "report only — jigs sweep --clean removes the 1 eligible",
  );
});
