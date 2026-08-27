import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { CliError } from "../errors.ts";
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

const deps = () => ({
  out: (line: string) => lines.push(line),
  serviceUrl: "http://svc.test:8990",
});

test("logs prints the run's status, its suspensions, and the workflow web pointer", async () => {
  fetchMock.mockResolvedValueOnce(
    new Response(
      JSON.stringify({
        runId: RUN,
        status: "running",
        logs: `npx workflow web --backend @workflow/world-postgres ${RUN}`,
        suspensions: [
          {
            key: "pr-gate:acme/api#41",
            reason: "waiting for approval",
            satisfiedBy: "github:pr:acme/api#41",
          },
        ],
      }),
    ),
  );
  await showLogs("AGE-317", deps());
  expect(fetchMock.mock.calls[0]?.[0]).toBe(
    "http://svc.test:8990/api/runs/AGE-317",
  );
  expect(lines).toEqual([
    `run ${RUN}`,
    "status running",
    "suspended on pr-gate:acme/api#41: waiting for approval",
    "  satisfied by github:pr:acme/api#41",
    // The service names the world it writes to; `workflow web` would
    // otherwise inspect the local one and find no run.
    `npx workflow web --backend @workflow/world-postgres ${RUN}`,
  ]);
});

test("a failed run's error is printed above the log pointer", async () => {
  fetchMock.mockResolvedValueOnce(
    new Response(
      JSON.stringify({
        runId: RUN,
        status: "failed",
        error: "ClaimConflictError: linear:ticket:… is already claimed",
      }),
    ),
  );
  await showLogs(RUN, deps());
  expect(lines).toEqual([
    `run ${RUN}`,
    "status failed",
    "error ClaimConflictError: linear:ticket:… is already claimed",
    `npx workflow web ${RUN}`,
  ]);
});

test("an unresolvable ref fails before the pointer is printed", async () => {
  fetchMock.mockResolvedValueOnce(
    new Response(JSON.stringify({ error: "not found" }), { status: 404 }),
  );
  const err = await showLogs("AGE-999", deps()).then(
    () => null,
    (thrown: unknown) => thrown as CliError,
  );
  expect(err?.message).toBe("run AGE-999 not found");
  expect(lines).toEqual([]);
});
