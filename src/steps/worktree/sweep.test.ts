import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { managedCodexHomePath } from "../agent/harnesses/codex-home.ts";
import { createRunDirectory } from "../run-directory/index.ts";
import * as create from "./create.ts";
import type { OwnerState } from "./owner.ts";
import type { WorktreeRow } from "./registry.ts";
import { classifySweep, type SweepInput, sweepWorktrees } from "./sweep.ts";
import { git, makeClonedBinding, makeFakeSql } from "./test-fixtures.ts";

// The classifier's rules as a table, then real git worktrees on disk against
// a faked registry for the join — what gets removed, what survives, and what
// the store ends up holding. The teardown matrix itself is teardown.test.ts.

function input(overrides: Partial<SweepInput> = {}): SweepInput {
  return {
    path: "/data/worktrees/acme/api/feat",
    branch: "feat",
    ownerRunId: "run_a",
    ownerTerminal: true,
    state: "active",
    onDisk: true,
    dirty: false,
    ...overrides,
  };
}

test("a non-terminal owner holds its worktree", () => {
  const entry = classifySweep(input({ ownerTerminal: false }));
  expect(entry.state).toBe("held");
  expect(entry.eligible).toBe(false);
});

test("a suspended run reads as running and is therefore held", () => {
  // The SDK has no `suspended` status — the join sees a non-terminal owner.
  expect(classifySweep(input({ ownerTerminal: false, dirty: true })).state).toBe("held");
});

test("a terminal owner with a clean tree is abandoned and eligible", () => {
  const entry = classifySweep(input());
  expect(entry.state).toBe("abandoned");
  expect(entry.eligible).toBe(true);
  expect(entry.requiresForce).toBe(false);
  expect(entry.ownerRunId).toBe("run_a");
});

test("a terminal owner with a dirty tree is abandoned-dirty and needs force", () => {
  const entry = classifySweep(input({ dirty: true }));
  expect(entry.state).toBe("abandoned-dirty");
  expect(entry.eligible).toBe(true);
  expect(entry.requiresForce).toBe(true);
});

test("a half-provisioned tree is kept for diagnosis until force", () => {
  const entry = classifySweep(input({ state: "provision-failed" }));
  expect(entry.state).toBe("provision-failed");
  expect(entry.requiresForce).toBe(true);
});

test("a live owner holds its worktree even in provision-failed", () => {
  expect(classifySweep(input({ state: "provision-failed", ownerTerminal: false })).state).toBe(
    "held",
  );
});

test("a registered path missing from disk is a stale row", () => {
  const entry = classifySweep(input({ onDisk: false }));
  expect(entry.state).toBe("missing");
  expect(entry.eligible).toBe(true);
  expect(entry.requiresForce).toBe(false);
});

let tmp: string;
let repoDir: string;
let remoteDir: string;
let worktreesDir: string;
let store: Map<string, WorktreeRow>;
let log: string[];

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "jigs-sweep-test-"));
  // The managed Codex homes the pass reclaims hang off the data home.
  vi.stubEnv("XDG_DATA_HOME", path.join(tmp, "data"));
  log = [];
  vi.spyOn(console, "log").mockImplementation((line: string) => {
    log.push(line);
  });
  // A real origin behind a real clone: whether a terminal run's branch is
  // merged is read off refs/remotes/origin/<default>.
  ({ repoDir, remoteDir, worktreesDir } = makeClonedBinding(tmp));
  store = new Map();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(tmp, { recursive: true, force: true });
});

function addWorktree(branch: string): string {
  const target = path.join(worktreesDir, branch);
  git(repoDir, "worktree", "add", "-q", target, "-b", branch, "refs/remotes/origin/main");
  return target;
}

function register(target: string, branch: string, overrides: Partial<WorktreeRow> = {}): void {
  store.set(target, {
    path: target,
    branch,
    ownerRunId: `run_${branch}`,
    state: "active",
    repoDir,
    ...overrides,
  });
}

const owners =
  (states: Record<string, OwnerState>) =>
  async (runId: string): Promise<OwnerState> =>
    states[runId] ?? { terminal: true, status: "unknown" };

function deps(states: Record<string, OwnerState> = {}) {
  return { sql: makeFakeSql(store), readOwner: owners(states) };
}

function codexHome(runId: string): string {
  const home = managedCodexHomePath(runId);
  mkdirSync(home, { recursive: true });
  return home;
}

const dirty = (target: string) => writeFileSync(path.join(target, "wip.txt"), "half-finished\n");

function commit(target: string, file: string): void {
  writeFileSync(path.join(target, file), `${file}\n`);
  git(target, "add", file);
  git(target, "commit", "-q", "-m", file);
}

test("a dry run deletes nothing", async () => {
  const clean = addWorktree("clean");
  const messy = addWorktree("messy");
  dirty(messy);
  register(clean, "clean");
  register(messy, "messy");

  const report = await sweepWorktrees({}, deps());
  expect(report.entries).toHaveLength(2);
  expect(report.removed).toEqual([]);
  // Nothing was decided, so no entry claims a branch outcome.
  expect(report.entries.map((entry) => entry.branchOutcome)).toEqual([undefined, undefined]);
  expect(existsSync(clean)).toBe(true);
  expect(existsSync(messy)).toBe(true);
  expect(store.size).toBe(2);
});

test("--clean removes the clean abandoned worktree and leaves the dirty one", async () => {
  const clean = addWorktree("clean");
  const messy = addWorktree("messy");
  dirty(messy);
  register(clean, "clean");
  register(messy, "messy");

  const report = await sweepWorktrees({ clean: true }, deps());
  expect(report.removed).toEqual([clean]);
  expect(existsSync(clean)).toBe(false);
  expect(existsSync(messy)).toBe(true);
  expect(store.has(clean)).toBe(false);
  expect(store.get(messy)?.state).toBe("abandoned-dirty");
});

test("paths scopes a clean to the approved worktrees only", async () => {
  const approvedTree = addWorktree("approved");
  const declined = addWorktree("declined");
  register(approvedTree, "approved");
  register(declined, "declined");

  const report = await sweepWorktrees({ clean: true, force: true, paths: [approvedTree] }, deps());
  expect(report.removed).toEqual([approvedTree]);
  expect(existsSync(approvedTree)).toBe(false);
  expect(existsSync(declined)).toBe(true);
  expect(store.has(declined)).toBe(true);
});

test("--clean --force removes the dirty one too", async () => {
  const messy = addWorktree("messy");
  dirty(messy);
  register(messy, "messy");

  const report = await sweepWorktrees({ clean: true, force: true }, deps());
  expect(report.removed).toEqual([messy]);
  expect(existsSync(messy)).toBe(false);
  expect(store.size).toBe(0);
});

test("a suspended run's worktree is held in every mode", async () => {
  const held = addWorktree("held");
  dirty(held);
  register(held, "held");
  const running = deps({ run_held: { terminal: false, status: "running" } });

  for (const options of [{}, { clean: true }, { clean: true, force: true }]) {
    const report = await sweepWorktrees(options, running);
    expect(report.entries[0]?.state).toBe("held");
    expect(report.removed).toEqual([]);
    expect(existsSync(held)).toBe(true);
  }
});

test("a half-provisioned tree is kept for diagnosis until --force", async () => {
  const broken = addWorktree("broken");
  register(broken, "broken", { state: "provision-failed" });

  await sweepWorktrees({ clean: true }, deps());
  expect(existsSync(broken)).toBe(true);

  await sweepWorktrees({ clean: true, force: true }, deps());
  expect(existsSync(broken)).toBe(false);
  // The branch survives: nothing was merged.
  expect(git(repoDir, "rev-parse", "--verify", "refs/heads/broken")).toMatch(/^[0-9a-f]{40}$/);
});

test("a registered path missing from disk drops only its row", async () => {
  register(path.join(worktreesDir, "ghost"), "ghost");
  const report = await sweepWorktrees({ clean: true }, deps());
  expect(report.entries[0]?.state).toBe("missing");
  expect(store.size).toBe(0);
  // A stale row's branch is nobody's decision.
  expect(report.entries[0]?.branchOutcome).toBeUndefined();
});

test("a completed owner's merged teardown deletes the row and the branch", async () => {
  const done = addWorktree("done");
  commit(done, "shipped.txt");
  // Merged is what earns the branch deletion, so origin's default branch has
  // to actually contain the work.
  git(done, "push", "-q", "origin", "done:main");
  git(repoDir, "fetch", "-q", "origin");
  register(done, "done");
  const report = await sweepWorktrees(
    { clean: true },
    deps({ run_done: { terminal: true, status: "completed" } }),
  );
  expect(store.size).toBe(0);
  // done (merged): the local branch goes with the worktree.
  expect(() => git(repoDir, "rev-parse", "--verify", "refs/heads/done")).toThrow();
  expect(report.entries[0]?.branchOutcome).toEqual({
    deleted: true,
    unmergedCommits: 0,
  });
});

test("one fetch serves every completed run sharing a clone", async () => {
  // The merge check reads a ref only fetch refreshes, and a pass can hold
  // dozens of rows: refetching per row would cost a round trip each.
  const fetches = vi.spyOn(create, "fetchOriginDefault");
  for (const branch of ["first", "second"]) {
    register(addWorktree(branch), branch);
  }

  await sweepWorktrees(
    { clean: true },
    deps({
      run_first: { terminal: true, status: "completed" },
      run_second: { terminal: true, status: "completed" },
    }),
  );

  expect(fetches.mock.calls).toEqual([[repoDir]]);
});

test("an untracked file does not cost a merged worktree its teardown", async () => {
  const done = addWorktree("done");
  commit(done, "shipped.txt");
  git(done, "push", "-q", "origin", "done:main");
  git(repoDir, "fetch", "-q", "origin");
  // Build output, not work: the branch is merged, so the tree still goes.
  dirty(done);
  register(done, "done");

  await sweepWorktrees(
    { clean: true },
    deps({ run_done: { terminal: true, status: "completed" } }),
  );
  expect(existsSync(done)).toBe(false);
  expect(store.size).toBe(0);
  expect(() => git(repoDir, "rev-parse", "--verify", "refs/heads/done")).toThrow();
});

test("the merge check sees work pushed since the clone last fetched", async () => {
  const done = addWorktree("done");
  commit(done, "shipped.txt");
  // The merge lands from elsewhere — a PR merged on GitHub — so rewind the
  // tracking ref the push moved: nothing in the clone knows about it yet.
  const stale = git(repoDir, "rev-parse", "refs/remotes/origin/main");
  git(done, "push", "-q", "origin", "done:main");
  git(repoDir, "update-ref", "refs/remotes/origin/main", stale);
  register(done, "done");
  // The sweep's own fetch of origin/<default> is the only one in the pass, so
  // it has to run before the merge is decided.
  await sweepWorktrees(
    { clean: true },
    deps({ run_done: { terminal: true, status: "completed" } }),
  );
  expect(() => git(repoDir, "rev-parse", "--verify", "refs/heads/done")).toThrow();
});

test("an unreachable origin costs a notice, not the pass", async () => {
  const done = addWorktree("done");
  commit(done, "shipped.txt");
  register(done, "done");
  git(repoDir, "remote", "set-url", "origin", path.join(tmp, "nonexistent"));

  const report = await sweepWorktrees(
    { clean: true },
    deps({ run_done: { terminal: true, status: "completed" } }),
  );

  expect(report.removed).toEqual([done]);
  expect(log.some((line) => line.includes("could not fetch"))).toBe(true);
  // The merge check fell back to the stale ref, which reads unmerged.
  expect(git(repoDir, "rev-parse", "--verify", "refs/heads/done")).toMatch(/^[0-9a-f]{40}$/);
});

test("a completed owner whose branch never merged keeps it as insurance", async () => {
  const done = addWorktree("done");
  commit(done, "unshipped.txt");
  commit(done, "unshipped-too.txt");
  register(done, "done");
  const report = await sweepWorktrees(
    { clean: true },
    deps({ run_done: { terminal: true, status: "completed" } }),
  );
  expect(existsSync(done)).toBe(false);
  expect(git(repoDir, "rev-parse", "--verify", "refs/heads/done")).toMatch(/^[0-9a-f]{40}$/);
  // The count is what the removed line reports the branch was kept for.
  expect(report.entries[0]?.branchOutcome).toEqual({
    deleted: false,
    unmergedCommits: 2,
  });
});

test("a failed owner's unmerged branch stays as insurance", async () => {
  const failed = addWorktree("failed");
  commit(failed, "unshipped.txt");
  register(failed, "failed");
  await sweepWorktrees(
    { clean: true },
    deps({
      run_failed: {
        terminal: true,
        status: "failed",
        release: { onSuccess: "release", onFailure: "release" },
      },
    }),
  );
  expect(existsSync(failed)).toBe(false);
  expect(git(repoDir, "rev-parse", "--verify", "refs/heads/failed")).toMatch(/^[0-9a-f]{40}$/);
});

test("a cancelled run's empty branch goes with its worktree", async () => {
  // Cancelled before the first commit: the tip is still the fork point, so
  // the branch is a copy of nothing.
  const stopped = addWorktree("stopped");
  register(stopped, "stopped");

  await sweepWorktrees(
    { clean: true },
    deps({
      run_stopped: {
        terminal: true,
        status: "cancelled",
        release: { onSuccess: "release", onFailure: "release" },
      },
    }),
  );

  expect(existsSync(stopped)).toBe(false);
  expect(() => git(repoDir, "rev-parse", "--verify", "refs/heads/stopped")).toThrow();
});

test("a cancelled run's redundant branch keeps its remote", async () => {
  const stopped = addWorktree("stopped");
  commit(stopped, "shipped.txt");
  git(stopped, "push", "-q", "origin", "stopped");
  git(stopped, "push", "-q", "origin", "stopped:main");
  git(repoDir, "fetch", "-q", "origin");
  register(stopped, "stopped");

  await sweepWorktrees(
    { clean: true },
    deps({
      run_stopped: {
        terminal: true,
        status: "cancelled",
        release: { onSuccess: "release", onFailure: "release" },
      },
    }),
  );

  expect(() => git(repoDir, "rev-parse", "--verify", "refs/heads/stopped")).toThrow();
  // The pushed branch is somebody's open PR: only the done row deletes it.
  expect(git(remoteDir, "rev-parse", "--verify", "refs/heads/stopped")).toMatch(/^[0-9a-f]{40}$/);
});

test("a cancelled run's dirty tree survives its empty branch", async () => {
  const stopped = addWorktree("stopped");
  dirty(stopped);
  register(stopped, "stopped");

  await sweepWorktrees(
    { clean: true },
    deps({
      run_stopped: {
        terminal: true,
        status: "cancelled",
        release: { onSuccess: "release", onFailure: "release" },
      },
    }),
  );

  expect(existsSync(stopped)).toBe(true);
  expect(store.get(stopped)?.state).toBe("abandoned-dirty");
  expect(git(repoDir, "rev-parse", "--verify", "refs/heads/stopped")).toMatch(/^[0-9a-f]{40}$/);
});

test("a cancelled run's branch stays when the ancestry cannot be proven", async () => {
  const stopped = addWorktree("stopped");
  register(stopped, "stopped");
  // An unreachable origin with no default branch recorded: neither the fetch
  // nor the ancestor check can answer, and branch deletion needs positive
  // evidence.
  git(repoDir, "remote", "set-url", "origin", path.join(tmp, "nonexistent"));
  git(repoDir, "symbolic-ref", "-d", "refs/remotes/origin/HEAD");

  const report = await sweepWorktrees(
    { clean: true },
    deps({
      run_stopped: {
        terminal: true,
        status: "cancelled",
        release: { onSuccess: "release", onFailure: "release" },
      },
    }),
  );

  expect(report.removed).toEqual([stopped]);
  expect(log.some((line) => line.includes("could not fetch"))).toBe(true);
  expect(existsSync(stopped)).toBe(false);
  expect(git(repoDir, "rev-parse", "--verify", "refs/heads/stopped")).toMatch(/^[0-9a-f]{40}$/);
  // No count either: nothing answered the ancestry question.
  expect(report.entries[0]?.branchOutcome).toEqual({ deleted: false });
});

test("the managed Codex home is removed once a run's last worktree is torn down", async () => {
  const one = addWorktree("one");
  const two = addWorktree("two");
  register(one, "one", { ownerRunId: "run_shared" });
  register(two, "two", { ownerRunId: "run_shared" });
  dirty(two);
  const home = codexHome("run_shared");

  // The dirty second tree survives, so the home is still in use.
  await sweepWorktrees({ clean: true }, deps());
  expect(existsSync(home)).toBe(true);

  await sweepWorktrees({ clean: true, force: true }, deps());
  expect(existsSync(home)).toBe(false);
});

test("a binding's empty worktrees directory goes, its clone stays", async () => {
  const only = addWorktree("only");
  register(only, "only");
  const report = await sweepWorktrees({ clean: true }, deps());
  expect(report.removedDirs).toContain(worktreesDir);
  expect(existsSync(worktreesDir)).toBe(false);
  expect(existsSync(repoDir)).toBe(true);
});

test("default failure policy keeps even a clean worktree until explicit manual approval", async () => {
  const target = addWorktree("failed");
  register(target, "failed");
  const dependencies = deps({ run_failed: { terminal: true, status: "failed" } });
  const report = await sweepWorktrees({ clean: true }, dependencies);
  expect(report.removed).toEqual([]);
  expect(report.entries[0]).toMatchObject({ policyKept: true, requiresForce: false });
  expect(report.entries[0]?.reason).toContain("onFailure");
  const approved = await sweepWorktrees(
    { clean: true, force: true, paths: [target] },
    dependencies,
  );
  expect(approved.removed).toEqual([target]);
});

test("manual sweep discovers scratch-only runs and preserves live, suspended, unknown and cross-factory directories", async () => {
  const failed = await createRunDirectory({ workflowRunId: "run_failed" });
  const completed = await createRunDirectory({ workflowRunId: "run_completed" });
  const active = await createRunDirectory({ workflowRunId: "run_active" });
  const suspended = await createRunDirectory({ workflowRunId: "run_suspended" });
  const unknown = await createRunDirectory({ workflowRunId: "run_other_factory" });
  const dependencies = deps({
    run_failed: { terminal: true, status: "failed" },
    run_completed: { terminal: true, status: "completed" },
    run_active: { terminal: false, status: "running" },
    run_suspended: { terminal: false, status: "running" },
  });
  const report = await sweepWorktrees({}, dependencies);
  expect(report.entries).toHaveLength(5);
  expect(report.entries.every((entry) => entry.kind === "run-directory")).toBe(true);
  expect(report.removed).toEqual([]);
  const cleaned = await sweepWorktrees({ clean: true }, dependencies);
  expect(cleaned.removed).toEqual([completed]);
  expect(existsSync(failed)).toBe(true);
  const forced = await sweepWorktrees({ clean: true, force: true }, dependencies);
  expect(forced.removed).toEqual([failed]);
  for (const directory of [active, suspended, unknown]) expect(existsSync(directory)).toBe(true);
});

test("failure release policy permits a requested clean pass for scratch and scoped approval selects only its path", async () => {
  const first = await createRunDirectory({ workflowRunId: "run_first" });
  const second = await createRunDirectory({ workflowRunId: "run_second" });
  const dependencies = deps({
    run_first: {
      terminal: true,
      status: "failed",
      release: { onSuccess: "release", onFailure: "release" },
    },
    run_second: {
      terminal: true,
      status: "failed",
      release: { onSuccess: "release", onFailure: "release" },
    },
  });
  const report = await sweepWorktrees({ clean: true, paths: [first] }, dependencies);
  expect(report.removed).toEqual([first]);
  expect(existsSync(second)).toBe(true);
});
