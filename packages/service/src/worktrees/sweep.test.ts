import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { OwnerState } from "./acquire";
import type { WorktreeRow } from "./registry";
import { classifySweep, type SweepInput, sweepWorktrees } from "./sweep";
import { git, makeClonedBinding, makeFakeSql } from "./test-fixtures";

// The classifier's rules as a table, then real git worktrees on disk against
// a faked registry for the join — what gets removed, what survives, and what
// the store ends up holding. The teardown matrix itself is teardown.test.ts.

function input(overrides: Partial<SweepInput> = {}): SweepInput {
  return {
    path: "/data/worktrees/acme/api/feat",
    branch: "feat",
    ownerRunId: "run_a",
    ownerTerminal: true,
    keep: false,
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
  expect(
    classifySweep(input({ ownerTerminal: false, dirty: true })).state,
  ).toBe("held");
});

test("keep: true is never eligible, even for a terminal owner", () => {
  const entry = classifySweep(input({ keep: true }));
  expect(entry.state).toBe("kept");
  expect(entry.eligible).toBe(false);
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
  expect(
    classifySweep(input({ state: "provision-failed", ownerTerminal: false }))
      .state,
  ).toBe("held");
});

test("keep: true wins over provision-failed", () => {
  expect(
    classifySweep(input({ state: "provision-failed", keep: true })).state,
  ).toBe("kept");
});

test("a registered path missing from disk is a stale row", () => {
  const entry = classifySweep(input({ onDisk: false }));
  expect(entry.state).toBe("missing");
  expect(entry.eligible).toBe(true);
  expect(entry.requiresForce).toBe(false);
});

let tmp: string;
let repoDir: string;
let worktreesDir: string;
let store: Map<string, WorktreeRow>;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "jigs-sweep-test-"));
  // A real origin behind a real clone: whether a completed run's branch is
  // merged is read off refs/remotes/origin/<default>.
  ({ repoDir, worktreesDir } = makeClonedBinding(tmp));
  store = new Map();
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function addWorktree(branch: string): string {
  const target = path.join(worktreesDir, branch);
  git(
    repoDir,
    "worktree",
    "add",
    "-q",
    target,
    "-b",
    branch,
    "refs/remotes/origin/main",
  );
  return target;
}

function register(
  target: string,
  branch: string,
  overrides: Partial<WorktreeRow> = {},
): void {
  store.set(target, {
    path: target,
    branch,
    ownerRunId: `run_${branch}`,
    state: "active",
    baseSha: "base1",
    headSha: "head1",
    behindDefault: 0,
    repoDir,
    keep: false,
    ...overrides,
  });
}

const owners =
  (states: Record<string, OwnerState>) =>
  async (runId: string): Promise<OwnerState> =>
    states[runId] ?? { terminal: true, status: "unknown" };

function deps(overrides: Record<string, unknown> = {}) {
  return {
    sql: makeFakeSql(store),
    readOwner: owners({}),
    removeCodexHome: () => {},
    ...overrides,
  };
}

const dirty = (target: string) =>
  writeFileSync(path.join(target, "wip.txt"), "half-finished\n");

test("a dry run deletes nothing", async () => {
  const clean = addWorktree("clean");
  const messy = addWorktree("messy");
  dirty(messy);
  register(clean, "clean");
  register(messy, "messy");

  const report = await sweepWorktrees({}, deps());
  expect(report.entries).toHaveLength(2);
  expect(report.removed).toEqual([]);
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

  const report = await sweepWorktrees(
    { clean: true, force: true, paths: [approvedTree] },
    deps(),
  );
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
  const running = deps({
    readOwner: owners({ run_held: { terminal: false, status: "running" } }),
  });

  for (const options of [{}, { clean: true }, { clean: true, force: true }]) {
    const report = await sweepWorktrees(options, running);
    expect(report.entries[0]?.state).toBe("held");
    expect(report.removed).toEqual([]);
    expect(existsSync(held)).toBe(true);
  }
});

test("keep: true survives --clean --force", async () => {
  const kept = addWorktree("kept");
  register(kept, "kept", { keep: true });
  const report = await sweepWorktrees({ clean: true, force: true }, deps());
  expect(report.entries[0]?.state).toBe("kept");
  expect(existsSync(kept)).toBe(true);
  expect(store.size).toBe(1);
});

test("a half-provisioned tree is kept for diagnosis until --force", async () => {
  const broken = addWorktree("broken");
  register(broken, "broken", { state: "provision-failed" });

  await sweepWorktrees({ clean: true }, deps());
  expect(existsSync(broken)).toBe(true);

  await sweepWorktrees({ clean: true, force: true }, deps());
  expect(existsSync(broken)).toBe(false);
  // The branch survives: nothing was merged.
  expect(git(repoDir, "rev-parse", "--verify", "refs/heads/broken")).toMatch(
    /^[0-9a-f]{40}$/,
  );
});

test("a registered path missing from disk drops only its row", async () => {
  register(path.join(worktreesDir, "ghost"), "ghost");
  const report = await sweepWorktrees({ clean: true }, deps());
  expect(report.entries[0]?.state).toBe("missing");
  expect(store.size).toBe(0);
});

test("a completed owner's teardown deletes the row and fetches the default branch once", async () => {
  const done = addWorktree("done");
  writeFileSync(path.join(done, "shipped.txt"), "shipped\n");
  git(done, "add", "shipped.txt");
  git(done, "commit", "-q", "-m", "shipped");
  // Merged is what earns the branch deletion, so origin's default branch has
  // to actually contain the work.
  git(done, "push", "-q", "origin", "done:main");
  git(repoDir, "fetch", "-q", "origin");
  register(done, "done");
  const fetches: string[] = [];
  await sweepWorktrees(
    { clean: true },
    deps({
      readOwner: owners({ run_done: { terminal: true, status: "completed" } }),
      fetchDefault: async (repoDir: string) => {
        fetches.push(repoDir);
      },
    }),
  );
  expect(fetches).toEqual([repoDir]);
  expect(store.size).toBe(0);
  // done (merged): the local branch goes with the worktree.
  expect(() =>
    git(repoDir, "rev-parse", "--verify", "refs/heads/done"),
  ).toThrow();
});

test("an untracked file does not cost a merged worktree its teardown", async () => {
  const done = addWorktree("done");
  writeFileSync(path.join(done, "shipped.txt"), "shipped\n");
  git(done, "add", "shipped.txt");
  git(done, "commit", "-q", "-m", "shipped");
  git(done, "push", "-q", "origin", "done:main");
  git(repoDir, "fetch", "-q", "origin");
  // Build output, not work: the branch is merged, so the tree still goes.
  dirty(done);
  register(done, "done");

  await sweepWorktrees(
    { clean: true },
    deps({
      readOwner: owners({ run_done: { terminal: true, status: "completed" } }),
    }),
  );
  expect(existsSync(done)).toBe(false);
  expect(store.size).toBe(0);
  expect(() =>
    git(repoDir, "rev-parse", "--verify", "refs/heads/done"),
  ).toThrow();
});

test("the merge check sees work pushed since the clone last fetched", async () => {
  const done = addWorktree("done");
  writeFileSync(path.join(done, "shipped.txt"), "shipped\n");
  git(done, "add", "shipped.txt");
  git(done, "commit", "-q", "-m", "shipped");
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
    deps({
      readOwner: owners({ run_done: { terminal: true, status: "completed" } }),
    }),
  );
  expect(() =>
    git(repoDir, "rev-parse", "--verify", "refs/heads/done"),
  ).toThrow();
});

test("an unreachable origin costs a notice, not the pass", async () => {
  const done = addWorktree("done");
  writeFileSync(path.join(done, "shipped.txt"), "shipped\n");
  git(done, "add", "shipped.txt");
  git(done, "commit", "-q", "-m", "shipped");
  register(done, "done");
  git(repoDir, "remote", "set-url", "origin", path.join(tmp, "nonexistent"));
  const lines: string[] = [];

  const report = await sweepWorktrees(
    { clean: true },
    deps({
      readOwner: owners({ run_done: { terminal: true, status: "completed" } }),
      log: (line: string) => lines.push(line),
    }),
  );

  expect(report.removed).toEqual([done]);
  expect(lines.some((line) => line.includes("could not fetch"))).toBe(true);
  // The merge check fell back to the stale ref, which reads unmerged.
  expect(git(repoDir, "rev-parse", "--verify", "refs/heads/done")).toMatch(
    /^[0-9a-f]{40}$/,
  );
});

test("a completed owner whose branch never merged keeps it as insurance", async () => {
  const done = addWorktree("done");
  writeFileSync(path.join(done, "unshipped.txt"), "unshipped\n");
  git(done, "add", "unshipped.txt");
  git(done, "commit", "-q", "-m", "unshipped");
  register(done, "done");
  await sweepWorktrees(
    { clean: true },
    deps({
      readOwner: owners({ run_done: { terminal: true, status: "completed" } }),
    }),
  );
  expect(existsSync(done)).toBe(false);
  expect(git(repoDir, "rev-parse", "--verify", "refs/heads/done")).toMatch(
    /^[0-9a-f]{40}$/,
  );
});

test("a failed owner's clean teardown keeps the branch as insurance", async () => {
  const failed = addWorktree("failed");
  register(failed, "failed");
  await sweepWorktrees(
    { clean: true },
    deps({
      readOwner: owners({ run_failed: { terminal: true, status: "failed" } }),
    }),
  );
  expect(existsSync(failed)).toBe(false);
  expect(git(repoDir, "rev-parse", "--verify", "refs/heads/failed")).toMatch(
    /^[0-9a-f]{40}$/,
  );
});

test("the managed Codex home is removed once a run's last worktree is torn down", async () => {
  const one = addWorktree("one");
  const two = addWorktree("two");
  register(one, "one", { ownerRunId: "run_shared" });
  register(two, "two", { ownerRunId: "run_shared" });
  dirty(two);
  const removedHomes: string[] = [];
  const spy = {
    removeCodexHome: (runKey: string) => removedHomes.push(runKey),
  };

  // The dirty second tree survives, so the home is still in use.
  await sweepWorktrees({ clean: true }, deps(spy));
  expect(removedHomes).toEqual([]);

  await sweepWorktrees({ clean: true, force: true }, deps(spy));
  expect(removedHomes).toEqual(["run_shared"]);
});

test("a binding's empty worktrees directory goes, its clone stays", async () => {
  const only = addWorktree("only");
  register(only, "only");
  const report = await sweepWorktrees({ clean: true }, deps());
  expect(report.removedDirs).toContain(worktreesDir);
  expect(existsSync(worktreesDir)).toBe(false);
  expect(existsSync(repoDir)).toBe(true);
});
