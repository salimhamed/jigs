import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ResourceRow } from "./registry.ts";
import { memoryRows } from "./test-fixtures.ts";

// The registry is the one stand-in: release runs the real kind handlers
// against real directories and records their outcomes in these rows.
const policy = vi.hoisted(() => ({ resolveReleasePolicy: vi.fn() }));

vi.mock("./release-policy.ts", () => ({ resolveReleasePolicy: policy.resolveReleasePolicy }));
vi.mock("./registry.ts", async (original) => ({
  ...(await original<typeof import("./registry.ts")>()),
  ...(await import("./test-fixtures.ts")).memoryRegistry(),
}));

const { releaseRun, releaseRunResources } = await import("./release.ts");

let data: string;
const RUN = "wrun_release";
const at = new Date("2026-09-25T00:00:00.000Z");

function row(kind: string, over: Partial<ResourceRow> = {}): ResourceRow {
  return {
    factory: "factory-a",
    runId: RUN,
    kind,
    identity: RUN,
    url: `file:///${kind}`,
    state: "live",
    reason: null,
    repoDir: null,
    branch: null,
    createdAt: at,
    updatedAt: at,
    ...over,
  };
}

const directory = (...parts: string[]) => {
  const target = path.join(data, "jigs", ...parts);
  mkdirSync(target, { recursive: true });
  return target;
};

const seed = (...rows: ResourceRow[]) => memoryRows.splice(0, Infinity, ...rows);

const states = () =>
  Object.fromEntries(memoryRows.map((entry) => [entry.kind, [entry.state, entry.reason]]));

beforeEach(() => {
  data = mkdtempSync(path.join(tmpdir(), "jigs-release-"));
  vi.stubEnv("XDG_DATA_HOME", data);
  memoryRows.length = 0;
  policy.resolveReleasePolicy.mockReset();
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(data, { recursive: true, force: true });
});

test("release removes run-owned directories and leaves recorded-only kinds untouched", async () => {
  const scratch = directory("scratch", RUN);
  const codex = directory("codex-homes", RUN);
  seed(row("run-directory"), row("codex-home"), row("pull-request", { identity: "a/b#1" }));

  const records = await releaseRun({} as never, "factory-a", RUN, "release", "kept by policy");

  expect(existsSync(scratch)).toBe(false);
  expect(existsSync(codex)).toBe(false);
  expect(states()).toEqual({
    "run-directory": ["released", "removed"],
    "codex-home": ["released", "removed"],
    "pull-request": ["live", null],
  });
  expect(records.map((record) => record.state)).toEqual(["released", "released", "live"]);
});

test("keep marks every releasable resource kept with the policy's reason", async () => {
  const scratch = directory("scratch", RUN);
  seed(row("run-directory"), row("pull-request", { identity: "a/b#1" }));

  await releaseRun({} as never, "factory-a", RUN, "keep", "onFailure policy keeps run resources");

  expect(existsSync(scratch)).toBe(true);
  expect(states()).toEqual({
    "run-directory": ["kept", "onFailure policy keeps run resources"],
    "pull-request": ["live", null],
  });
});

test("a kept worktree keeps the harness homes that hold its sessions", async () => {
  const pi = directory("pi-homes", RUN);
  // No clone or branch recorded: the worktree handler refuses it.
  seed(row("pi-home"), row("worktree", { identity: path.join(data, "tree") }));

  await releaseRun({} as never, "factory-a", RUN, "release", "kept by policy");

  expect(existsSync(pi)).toBe(true);
  expect(states()).toEqual({
    worktree: ["kept", "not provisioned by jigs"],
    "pi-home": ["kept", "kept with the run's worktree"],
  });
});

test("kept and released records are final; failed ones are tried again", async () => {
  directory("scratch", RUN);
  seed(
    row("run-directory", { state: "failed", reason: "release failed: EBUSY" }),
    row("codex-home", { state: "kept", reason: "onSuccess policy keeps run resources" }),
    row("pi-home", { state: "released", reason: "removed" }),
  );

  await releaseRun({} as never, "factory-a", RUN, "release", "kept by policy");

  expect(states()).toEqual({
    "run-directory": ["released", "removed"],
    "codex-home": ["kept", "onSuccess policy keeps run resources"],
    "pi-home": ["released", "removed"],
  });
});

test("another factory's records are never visited", async () => {
  const scratch = directory("scratch", RUN);
  seed(row("run-directory", { factory: "factory-b" }));

  await releaseRun({} as never, "factory-a", RUN, "release", "kept by policy");

  expect(existsSync(scratch)).toBe(true);
  expect(memoryRows[0]?.state).toBe("live");
});

test("the release step applies an explicit policy's success action without resolving one", async () => {
  directory("scratch", RUN);
  seed(row("run-directory"));
  const keep = { onSuccess: "keep", onFailure: "keep" } as const;

  const report = await releaseRunResources(
    { workflowRunId: RUN, workflowName: "compiled" },
    { service: { dashboardPort: 9000 }, workflows: {} },
    keep,
  );

  expect(policy.resolveReleasePolicy).not.toHaveBeenCalled();
  expect(report.policy).toEqual(keep);
  expect(report.resources).toMatchObject([
    { kind: "run-directory", state: "kept", reason: "onSuccess policy keeps run resources" },
  ]);
});

test("without a policy, the release step resolves the configured one", async () => {
  memoryRows.length = 0;
  const discard = { onSuccess: "release", onFailure: "release" } as const;
  policy.resolveReleasePolicy.mockResolvedValue(discard);
  const metadata = { workflowRunId: RUN, workflowName: "compiled" };
  const definition = { service: { dashboardPort: 9000 }, workflows: {} };

  const report = await releaseRunResources(metadata, definition);

  expect(policy.resolveReleasePolicy).toHaveBeenCalledWith(metadata, definition);
  expect(report).toEqual({ policy: discard, resources: [] });
});
