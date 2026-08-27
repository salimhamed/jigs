import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ResolvedBinding } from "jigs";
import type { Sql } from "postgres";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { WorktreeRow } from "./registry";
import { type OwnerState, sweepWorktrees } from "./sweep";

// Real git worktrees on disk against a faked registry: the classifier and the
// teardown matrix are already covered in jigs, so what this file proves is the
// join — what gets removed, what survives, and what the store ends up holding.
function makeFakeSql(store: Map<string, WorktreeRow>): Sql {
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join("$").trimStart();
    if (query.startsWith("SELECT")) {
      return Promise.resolve([...store.values()]);
    }
    if (query.startsWith("UPDATE")) {
      const [state, rowPath] = values as [string, string];
      const row = store.get(rowPath);
      if (row !== undefined) store.set(rowPath, { ...row, state });
      return Promise.resolve([]);
    }
    if (query.startsWith("DELETE")) {
      store.delete(values[0] as string);
      return Promise.resolve([]);
    }
    return Promise.resolve([]);
  };
  return sql as unknown as Sql;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    },
  }).trim();
}

let tmp: string;
let checkout: string;
let workspace: string;
let store: Map<string, WorktreeRow>;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "jigs-sweep-test-"));
  checkout = path.join(tmp, "checkout");
  workspace = path.join(tmp, "workspace");
  mkdirSync(checkout, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  git(checkout, "init", "-q", "--initial-branch", "main");
  git(checkout, "config", "user.name", "jigs-fixture");
  git(checkout, "config", "user.email", "fixture@jigs.test");
  writeFileSync(path.join(checkout, "README.md"), "# fixture\n");
  git(checkout, "add", "README.md");
  git(checkout, "commit", "-q", "-m", "initial");
  store = new Map();
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const binding: ResolvedBinding = {
  name: "api",
  checkoutRoot: "",
  remote: "git@github.com:acme/api.git",
  workspaceDir: "",
  ffDefaultBranch: true,
};

function addWorktree(branch: string): string {
  const target = path.join(workspace, branch);
  git(checkout, "worktree", "add", "-q", target, "-b", branch);
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
    binding: "api",
    checkoutRoot: checkout,
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
    bindings: () => [
      { ...binding, checkoutRoot: checkout, workspaceDir: workspace },
    ],
    factoryRoot: () => tmp,
    readOwner: owners({}),
    fastForward: async () => ({ moved: false, skipped: "disabled" as const }),
    removeCodexHome: () => {},
    log: () => {},
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
  expect(git(checkout, "rev-parse", "--verify", "refs/heads/broken")).toMatch(
    /^[0-9a-f]{40}$/,
  );
});

test("an unregistered directory is listed and only deleted with --clean", async () => {
  const loose = addWorktree("loose");

  const report = await sweepWorktrees({}, deps());
  expect(report.entries[0]).toMatchObject({
    state: "unregistered",
    eligible: true,
  });
  expect(existsSync(loose)).toBe(true);

  await sweepWorktrees({ clean: true }, deps());
  expect(existsSync(loose)).toBe(false);
});

test("a registered path missing from disk drops only its row", async () => {
  register(path.join(workspace, "ghost"), "ghost");
  const report = await sweepWorktrees({ clean: true }, deps());
  expect(report.entries[0]?.state).toBe("missing");
  expect(store.size).toBe(0);
});

test("a completed owner's teardown deletes the row and fast-forwards the default branch", async () => {
  const done = addWorktree("done");
  register(done, "done");
  const ffCalls: string[] = [];
  await sweepWorktrees(
    { clean: true },
    deps({
      readOwner: owners({ run_done: { terminal: true, status: "completed" } }),
      fastForward: async ({ checkoutRoot }: { checkoutRoot: string }) => {
        ffCalls.push(checkoutRoot);
        return { moved: false, skipped: "already-current" as const };
      },
    }),
  );
  expect(ffCalls).toEqual([checkout]);
  expect(store.size).toBe(0);
  // done (merged): the local branch goes with the worktree.
  expect(() =>
    git(checkout, "rev-parse", "--verify", "refs/heads/done"),
  ).toThrow();
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
  expect(git(checkout, "rev-parse", "--verify", "refs/heads/failed")).toMatch(
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

test("empty workspace directories are removed after the last worktree goes", async () => {
  const only = addWorktree("only");
  register(only, "only");
  const report = await sweepWorktrees({ clean: true }, deps());
  expect(report.removedDirs).toContain(workspace);
  expect(existsSync(workspace)).toBe(false);
});
