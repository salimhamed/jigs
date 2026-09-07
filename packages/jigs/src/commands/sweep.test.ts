import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { runSweep } from "./sweep.ts";

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

const deps = (confirm?: (question: string) => Promise<boolean>) => ({
  out: (line: string) => lines.push(line),
  serviceUrl: "http://svc.test:8990",
  ...(confirm === undefined ? {} : { confirm }),
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

test("--force posts one yes-to-everything clean and prints the summary", async () => {
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
  const result = await runSweep(deps(), { force: true });
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
  expect(lines[1]).toContain("held");
  expect(lines.at(-1)).toBe("1 removed, 1 held");
});

test("a bare sweep with no terminal reports and points at the removal paths", async () => {
  respond({
    entries: [entry({ ownerRunId: "run_a" })],
    removed: [],
    removedDirs: [],
  });
  await runSweep(deps());
  expect(fetchMock.mock.calls[0]?.[1].body).toBe(
    JSON.stringify({ clean: false, force: false }),
  );
  expect(lines.at(-1)).toBe(
    "report only — rerun in a terminal to be asked per worktree, or --force to remove all 1",
  );
});

test("a bare sweep with nothing eligible stays a plain report", async () => {
  respond({ entries: [], removed: [], removedDirs: [] });
  await runSweep(deps());
  expect(lines).toEqual(["no worktrees", "0 removed, 0 held"]);
});

test("interactive sweep cleans exactly the approved paths, with force", async () => {
  respond({
    entries: [
      entry({ ownerRunId: "run_a" }),
      entry({
        path: "/data/wt/dirty",
        state: "abandoned-dirty",
        requiresForce: true,
        ownerRunId: "run_c",
        reason: "the tree holds uncommitted work",
      }),
    ],
    removed: [],
    removedDirs: [],
  });
  respond({
    entries: [entry({ ownerRunId: "run_a" })],
    removed: ["/data/wt/feat"],
    removedDirs: [],
  });
  const questions: string[] = [];
  const confirm = async (question: string) => {
    questions.push(question);
    return question.includes("/data/wt/feat");
  };
  const result = await runSweep(deps(confirm), {});
  expect(questions).toHaveLength(2);
  expect(questions[1]).toContain("HOLDS UNCOMMITTED WORK");
  expect(fetchMock.mock.calls[1]?.[1].body).toBe(
    JSON.stringify({ clean: true, force: true, paths: ["/data/wt/feat"] }),
  );
  expect(result.removed).toEqual(["/data/wt/feat"]);
});

test("interactive sweep with every answer no removes nothing", async () => {
  respond({
    entries: [entry({ ownerRunId: "run_a" })],
    removed: [],
    removedDirs: [],
  });
  await runSweep(
    deps(async () => false),
    {},
  );
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(lines.at(-1)).toBe("nothing approved — nothing removed");
});
