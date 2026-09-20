import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, expect, test } from "vitest";
import { CLEANUP_STATE_ATTRIBUTE, encodeCleanupProgress } from "../../blocks/runtime/cleanup.ts";
import { resourceAttribute } from "../../blocks/runtime/resources.ts";
import { factorySlug } from "./layout.ts";
import type { WorktreeRow } from "./registry.ts";
import { inventoryResources, pruneResources, type ResourceRun } from "./resources.ts";
import { git, makeClonedBinding, makeFakeSql } from "./test-fixtures.ts";

let tmp: string;
let dataDir: string;
let factoryRoot: string;
let repoDir: string;
let worktreesDir: string;
let store: Map<string, WorktreeRow>;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "jigs-resources-test-"));
  dataDir = path.join(tmp, "data", "jigs");
  factoryRoot = path.join(tmp, "factory");
  mkdirSync(factoryRoot, { recursive: true });
  const binding = path.join(dataDir, "bindings", factorySlug(factoryRoot), "api");
  ({ repoDir, worktreesDir } = makeClonedBinding(tmp, binding));
  store = new Map();
});

afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function addWorktree(branch: string): string {
  const target = path.join(worktreesDir, branch);
  git(repoDir, "worktree", "add", "-q", target, "-b", branch, "refs/remotes/origin/main");
  store.set(target, {
    path: target,
    branch,
    ownerRunId: `wrun_${branch}`,
    state: "active",
    repoDir,
  });
  return target;
}

function run(
  branch: string,
  target: string,
  options: { status?: string; action?: "keep" | "release" } = {},
): ResourceRun {
  const resource = resourceAttribute({
    kind: "worktree",
    identity: target,
    url: pathToFileURL(target).href,
  });
  return {
    runId: `wrun_${branch}`,
    workflowName: "workflow//./workflows/ship//shipWorkflow",
    status: options.status ?? "completed",
    attributes: {
      [resource.key]: resource.value,
      [CLEANUP_STATE_ATTRIBUTE]: encodeCleanupProgress({
        status: options.action === "keep" ? "kept" : "failed",
        outcome: "success",
        action: options.action ?? "release",
      }),
    },
  };
}

function input(runs: ResourceRun[], includeKept = false) {
  return {
    runs,
    worktrees: [...store.values()],
    factoryRoot,
    dataDir,
    ownedWorkflowIds: new Set(["workflow//./workflows/ship//shipWorkflow"]),
    includeKept,
  };
}

const unlocked = async <T>(
  sql: ReturnType<typeof makeFakeSql>,
  _runId: string,
  action: (locked: ReturnType<typeof makeFakeSql>) => Promise<T>,
) => action(sql);

test("preview is immutable and a repeated apply safely converges", async () => {
  const target = addWorktree("merged");
  const runs = [run("merged", target)];
  const preview = await inventoryResources(input(runs));

  expect(preview.entries).toMatchObject([{ eligible: true, exists: true }]);
  expect(existsSync(target)).toBe(true);
  expect(store.has(target)).toBe(true);

  const sql = makeFakeSql(store);
  const applied = await pruneResources(input(runs), sql, unlocked);
  expect(applied.entries).toMatchObject([{ action: "remove", reason: "removed" }]);
  expect(existsSync(target)).toBe(false);
  expect(store.has(target)).toBe(false);

  const again = await pruneResources({ ...input(runs), worktrees: [] }, sql, unlocked);
  expect(again.entries[0]).toMatchObject({ eligible: false, action: "skip" });
});

test("apply removes the stale registry row for an already absent worktree", async () => {
  const target = addWorktree("absent");
  const runs = [run("absent", target)];
  git(repoDir, "worktree", "remove", "--force", target);

  const preview = await inventoryResources(input(runs));
  expect(preview.entries).toMatchObject([
    {
      exists: false,
      eligible: true,
      reason: "registered worktree is absent; its stale registry row can be removed",
    },
  ]);

  const sql = makeFakeSql(store);
  const applied = await pruneResources(input(runs), sql, unlocked);
  expect(applied.entries).toMatchObject([{ action: "remove" }]);
  expect(store.has(target)).toBe(false);
});

test("kept resources need opt-in, which still preserves dirty and unmerged work", async () => {
  const merged = addWorktree("kept-merged");
  const dirty = addWorktree("kept-dirty");
  const unmerged = addWorktree("kept-unmerged");
  writeFileSync(path.join(dirty, "dirty.txt"), "not committed\n");
  writeFileSync(path.join(unmerged, "work.txt"), "committed locally\n");
  git(unmerged, "add", "work.txt");
  git(
    unmerged,
    "-c",
    "user.name=jigs",
    "-c",
    "user.email=jigs@test",
    "commit",
    "-q",
    "-m",
    "local",
  );
  const runs = [
    run("kept-merged", merged, { action: "keep" }),
    run("kept-dirty", dirty, { action: "keep" }),
    run("kept-unmerged", unmerged, { action: "keep" }),
  ];

  expect((await inventoryResources(input(runs))).entries.every((entry) => !entry.eligible)).toBe(
    true,
  );
  const opted = await inventoryResources(input(runs, true));
  expect(opted.entries.find((entry) => entry.identity === merged)?.eligible).toBe(true);
  expect(opted.entries.find((entry) => entry.identity === dirty)?.reason).toContain("dirty");
  expect(opted.entries.find((entry) => entry.identity === unmerged)?.reason).toContain("unmerged");
});

test("nonterminal, cross-factory, unknown-owner, arbitrary URLs and symlink escapes stay", async () => {
  const active = addWorktree("active");
  const unknown = path.join(worktreesDir, "unknown");
  mkdirSync(unknown, { recursive: true });
  const outside = path.join(tmp, "outside");
  mkdirSync(outside);
  const escaped = path.join(worktreesDir, "escaped");
  symlinkSync(outside, escaped);
  store.set(escaped, {
    path: escaped,
    branch: "escaped",
    ownerRunId: "wrun_escaped",
    state: "active",
    repoDir,
  });
  const remote = resourceAttribute({
    kind: "pull-request",
    identity: "one",
    url: "https://example.test/1",
  });
  const remoteRun = run("remote", active);
  remoteRun.runId = "wrun_remote";
  remoteRun.attributes[remote.key] = remote.value;

  const report = await inventoryResources({
    ...input([
      run("active", active, { status: "running" }),
      run("unknown", unknown),
      run("escaped", escaped),
      remoteRun,
    ]),
    ownedWorkflowIds: new Set(["workflow//./workflows/ship//shipWorkflow"]),
  });

  expect(report.entries.find((entry) => entry.identity === active)?.reason).toContain(
    "not terminal",
  );
  expect(report.entries.find((entry) => entry.identity === unknown)?.ownership).toBe("unknown");
  expect(report.entries.find((entry) => entry.identity === escaped)?.reason).toContain(
    "symbolic link",
  );
  expect(report.entries.find((entry) => entry.kind === "pull-request")).toMatchObject({
    exists: null,
    eligible: false,
  });
});

test("a registry row from another factory cannot authorize deletion", async () => {
  const otherBinding = path.join(dataDir, "bindings", "other-factory", "api");
  const otherRepo = path.join(otherBinding, "repo.git");
  const otherTarget = path.join(otherBinding, "worktrees", "foreign");
  mkdirSync(otherRepo, { recursive: true });
  mkdirSync(otherTarget, { recursive: true });
  store.set(otherTarget, {
    path: otherTarget,
    branch: "foreign",
    ownerRunId: "wrun_foreign",
    state: "active",
    repoDir: otherRepo,
  });

  const report = await inventoryResources(input([run("foreign", otherTarget)]));

  expect(report.entries).toMatchObject([
    {
      identity: otherTarget,
      ownership: "other-factory",
      eligible: false,
      reason: "registry paths do not belong to this factory binding",
    },
  ]);
});

test("only the exact registered scratch directory is removable", async () => {
  const runId = "wrun_scratch";
  const scratch = path.join(dataDir, "scratch", runId);
  mkdirSync(scratch, { recursive: true });
  const resource = resourceAttribute({
    kind: "run-directory",
    identity: runId,
    url: pathToFileURL(scratch).href,
  });
  const scratchRun: ResourceRun = {
    runId,
    workflowName: "workflow//./workflows/ship//shipWorkflow",
    status: "cancelled",
    attributes: {
      [resource.key]: resource.value,
      [CLEANUP_STATE_ATTRIBUTE]: encodeCleanupProgress({
        status: "running",
        outcome: "failure",
        action: "release",
      }),
    },
  };
  const sql = makeFakeSql(store);
  const report = await pruneResources(input([scratchRun]), sql, unlocked);
  expect(report.entries).toMatchObject([{ action: "remove" }]);
  expect(existsSync(scratch)).toBe(false);
});

test("apply reports a partial failure and continues with independent resources", async () => {
  const first = "wrun_scratch_failed";
  const second = "wrun_scratch_removed";
  const runs = [first, second].map((runId) => {
    const scratch = path.join(dataDir, "scratch", runId);
    mkdirSync(scratch, { recursive: true });
    const resource = resourceAttribute({
      kind: "run-directory",
      identity: runId,
      url: pathToFileURL(scratch).href,
    });
    return {
      runId,
      workflowName: "workflow//./workflows/ship//shipWorkflow",
      status: "completed",
      attributes: {
        [resource.key]: resource.value,
        [CLEANUP_STATE_ATTRIBUTE]: encodeCleanupProgress({
          status: "running",
          outcome: "failure",
          action: "release",
        }),
      },
    } satisfies ResourceRun;
  });
  const sql = makeFakeSql(store);
  const failFirst = async <T>(
    database: typeof sql,
    runId: string,
    action: (locked: typeof sql) => Promise<T>,
  ): Promise<T> => {
    if (runId === first) throw new Error("simulated deletion failure");
    return action(database);
  };

  const report = await pruneResources(input(runs), sql, failFirst);

  expect(report.complete).toBe(false);
  expect(report.entries.find((entry) => entry.runId === first)).toMatchObject({
    action: "skip",
    error: "Error: simulated deletion failure",
  });
  expect(report.entries.find((entry) => entry.runId === second)).toMatchObject({
    action: "remove",
  });
  expect(existsSync(path.join(dataDir, "scratch", first))).toBe(true);
  expect(existsSync(path.join(dataDir, "scratch", second))).toBe(false);
});
