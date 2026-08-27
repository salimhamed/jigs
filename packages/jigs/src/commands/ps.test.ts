import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { listRunsForPs } from "./ps.ts";

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

const NOW = new Date("2026-08-26T12:00:00.000Z");
const RUN = "wrun_01K3ANBZ4TQ8W9YV6H2E5C7DKM";

const respond = (body: unknown) =>
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body)));

test("an empty service prints no runs", async () => {
  respond({ runs: [], worktrees: [] });
  await listRunsForPs(deps(), NOW);
  expect(lines).toEqual(["no runs"]);
});

test("a suspended run renders as suspended, not running", async () => {
  respond({
    runs: [
      {
        runId: RUN,
        pipeline: "suspension-demo",
        status: "suspended",
        createdAt: "2026-08-26T11:30:00.000Z",
      },
    ],
    worktrees: [],
  });
  await listRunsForPs(deps(), NOW);
  expect(lines).toEqual([
    "RUN                              PIPELINE         STATUS     AGE",
    `${RUN}  suspension-demo  suspended  30m`,
  ]);
});

test("a worktree the registry marks abandoned-dirty is shown, not filtered", async () => {
  respond({
    runs: [
      {
        runId: RUN,
        pipeline: "suspension-demo",
        status: "failed",
        createdAt: "2026-08-25T12:00:00.000Z",
      },
    ],
    worktrees: [
      {
        path: "/home/dev/worktrees/api/age-317",
        branch: "salimhamed/age-317",
        state: "abandoned-dirty",
        ownerRunId: RUN,
      },
    ],
  });
  await listRunsForPs(deps(), NOW);
  const worktreeLine = lines.find((line) => line.includes("age-317"));
  expect(worktreeLine).toContain("/home/dev/worktrees/api/age-317");
  expect(worktreeLine).toContain("abandoned-dirty");
  expect(worktreeLine).toContain(RUN);
  expect(lines.some((line) => line.startsWith("WORKTREE  "))).toBe(true);
  // A blank line separates the two tables.
  expect(lines[2]).toBe("");
});
