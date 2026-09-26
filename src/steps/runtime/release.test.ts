import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { git, makeClonedBinding } from "../workspaces/test-fixtures.ts";
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

const { MAX_RELEASE_ATTEMPTS, releaseRun, releaseRunResources } = await import("./release.ts");

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
    attempts: 0,
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

test("release removes run-owned directories and marks recorded-only kinds released", async () => {
  const scratch = directory("scratch", RUN);
  const codex = directory("codex-homes", RUN);
  seed(row("run-directory"), row("codex-home"), row("pull-request", { identity: "a/b#1" }));

  const records = await releaseRun({} as never, "factory-a", RUN, "release", "success");

  expect(existsSync(scratch)).toBe(false);
  expect(existsSync(codex)).toBe(false);
  expect(states()).toEqual({
    "run-directory": ["released", "removed"],
    "codex-home": ["released", "removed"],
    "pull-request": ["released", "recorded only"],
  });
  expect(records.map((record) => record.state)).toEqual(["released", "released", "released"]);
});

test("keep marks every releasable resource kept with the policy's reason", async () => {
  const scratch = directory("scratch", RUN);
  seed(row("run-directory"), row("pull-request", { identity: "a/b#1" }));

  await releaseRun({} as never, "factory-a", RUN, "keep", "failure");

  expect(existsSync(scratch)).toBe(true);
  expect(states()).toEqual({
    "run-directory": ["kept", "onFailure policy keeps run resources"],
    "pull-request": ["released", "recorded only"],
  });
});

function worktreeRow(branch: string, commit = false): ResourceRow {
  const { repoDir, worktreesDir } = makeClonedBinding(data);
  const target = path.join(worktreesDir, branch);
  git(repoDir, "worktree", "add", "-q", target, "-b", branch, "refs/remotes/origin/main");
  if (commit) {
    writeFileSync(path.join(target, "work.txt"), "work\n");
    git(target, "add", "work.txt");
    git(target, "commit", "-q", "-m", "work");
  }
  return row("worktree", { identity: target, repoDir, branch });
}

test("one pass releases a clean worktree and then the harness homes waiting for it", async () => {
  const pi = directory("pi-homes", RUN);
  const tree = worktreeRow("feat");
  seed(row("pi-home"), tree);

  await releaseRun({} as never, "factory-a", RUN, "release", "success");

  expect(existsSync(tree.identity)).toBe(false);
  expect(existsSync(pi)).toBe(false);
  expect(states()).toEqual({
    "pi-home": ["released", "removed"],
    worktree: ["released", "worktree and merged branch removed"],
  });
});

test("a dirty worktree is kept, and the harness homes that hold its sessions with it", async () => {
  const pi = directory("pi-homes", RUN);
  const tree = worktreeRow("dirty");
  writeFileSync(path.join(tree.identity, "wip.txt"), "uncommitted\n");
  seed(row("pi-home"), tree);

  await releaseRun({} as never, "factory-a", RUN, "release", "success");

  expect(existsSync(path.join(tree.identity, "wip.txt"))).toBe(true);
  expect(existsSync(pi)).toBe(true);
  expect(states()).toEqual({
    "pi-home": ["kept", "kept with the run's worktree"],
    worktree: ["kept", "uncommitted work kept"],
  });
});

test("a failing worktree leaves the harness homes live until a later attempt", async () => {
  const codex = directory("codex-homes", RUN);
  const tree = worktreeRow("locked");
  git(tree.repoDir as string, "worktree", "lock", tree.identity);
  seed(row("codex-home"), tree);

  await releaseRun({} as never, "factory-a", RUN, "release", "success");

  expect(existsSync(codex)).toBe(true);
  expect(memoryRows.find((entry) => entry.kind === "worktree")).toMatchObject({
    state: "failed",
    attempts: 1,
  });
  expect(memoryRows.find((entry) => entry.kind === "codex-home")).toMatchObject({
    state: "live",
    reason: "waits for the run's worktree",
  });
});

test("a failed resource is retried until the attempt cap, then kept with its last error", async () => {
  const tree = worktreeRow("stuck");
  git(tree.repoDir as string, "worktree", "lock", tree.identity);
  seed(tree);

  for (let attempt = 1; attempt < MAX_RELEASE_ATTEMPTS; attempt += 1) {
    await releaseRun({} as never, "factory-a", RUN, "release", "success");
    expect(memoryRows[0]).toMatchObject({ state: "failed", attempts: attempt });
  }
  await releaseRun({} as never, "factory-a", RUN, "release", "success");

  expect(memoryRows[0]?.state).toBe("kept");
  expect(memoryRows[0]?.reason).toMatch(
    new RegExp(`^release failed: .*\\(gave up after ${MAX_RELEASE_ATTEMPTS} attempts\\)$`, "s"),
  );
  expect(existsSync(tree.identity)).toBe(true);
});

test("kept and released records are final; failed ones are tried again", async () => {
  directory("scratch", RUN);
  seed(
    row("run-directory", { state: "failed", reason: "release failed: EBUSY", attempts: 2 }),
    row("codex-home", { state: "kept", reason: "onSuccess policy keeps run resources" }),
    row("pi-home", { state: "released", reason: "removed" }),
  );

  await releaseRun({} as never, "factory-a", RUN, "release", "success");

  expect(states()).toEqual({
    "run-directory": ["released", "removed"],
    "codex-home": ["kept", "onSuccess policy keeps run resources"],
    "pi-home": ["released", "removed"],
  });
});

test("another factory's records are never visited", async () => {
  const scratch = directory("scratch", RUN);
  seed(row("run-directory", { factory: "factory-b" }));

  await releaseRun({} as never, "factory-a", RUN, "release", "success");

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
