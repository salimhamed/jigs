import {
  existsSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import {
  applyTeardown,
  classifySweep,
  decideTeardown,
  describeFf,
  fastForwardDefaultBranch,
  isBranchMerged,
  isWorktreeDirty,
  listWorktreePaths,
  type ResolvedBinding,
  removeManagedCodexHome,
  resolveBindings,
  type SweepEntry,
  worktreeParentDir,
} from "jigs";
import type { Sql } from "postgres";
import { type OwnerState, readOwner } from "./acquire";
import { deleteWorktree, listWorktrees, setWorktreeState } from "./registry";
import { factoryRoot } from "./request";

// The one disk-against-registry-against-run-states join. Automatic teardown
// and `jigs sweep` are the same function: the SDK exposes no run-completion
// callback, and a workflow-body `finally` fires on every suspension because
// WorkflowSuspension is a thrown Error — so a terminal-state join is the only
// honest trigger, and the teardown matrix falls out of the classifier.

// Remove the tree, keep both branches: what a discard with no merge behind it
// looks like, whether the tree was dirty, unregistered, or half-provisioned.
const DISCARD_TREE = {
  removeWorktree: true,
  force: true,
  deleteLocalBranch: false,
  deleteRemoteBranch: false,
  preserve: null,
} as const;

export interface SweepOptions {
  clean?: boolean;
  force?: boolean;
  // Defaults on for a human running `jigs sweep`; the unattended pass turns
  // it off, because a workspace_dir binding places worktrees directly in the
  // operator's own directory, whose other contents a timer must never touch.
  includeUnregistered?: boolean;
}

export interface SweepDeps {
  sql: Sql;
  readOwner?: (runId: string) => Promise<OwnerState>;
  bindings?: () => ResolvedBinding[];
  factoryRoot?: () => string;
  fastForward?: typeof fastForwardDefaultBranch;
  removeCodexHome?: (runKey: string) => void;
  log?: (line: string) => void;
}

export interface SweepReport {
  entries: SweepEntry[];
  removed: string[];
  removedDirs: string[];
}

export async function sweepWorktrees(
  options: SweepOptions,
  deps: SweepDeps,
): Promise<SweepReport> {
  const clean = options.clean === true;
  const force = options.force === true;
  const owner = deps.readOwner ?? readOwner;
  const ff = deps.fastForward ?? fastForwardDefaultBranch;
  const removeCodexHome = deps.removeCodexHome ?? removeManagedCodexHome;
  const log = deps.log ?? ((line: string) => console.log(line));

  const rows = await listWorktrees(deps.sql);
  const byPath = new Map(rows.map((row) => [row.path, row]));
  const owners = new Map<string, OwnerState>();
  for (const row of rows) {
    if (!owners.has(row.ownerRunId)) {
      owners.set(row.ownerRunId, await owner(row.ownerRunId));
    }
  }

  const entries: SweepEntry[] = [];
  for (const row of rows) {
    const onDisk = existsSync(row.path);
    entries.push(
      classifySweep({
        path: row.path,
        branch: row.branch,
        ownerRunId: row.ownerRunId,
        ownerTerminal: owners.get(row.ownerRunId)?.terminal ?? true,
        keep: row.keep,
        state: row.state,
        onDisk,
        dirty: onDisk ? await isWorktreeDirty(row.path) : false,
        registered: true,
      }),
    );
  }

  // Directories the registry never heard of, found by scanning where each
  // binding's worktrees would live.
  const parents = new Map<string, ResolvedBinding>();
  for (const binding of (deps.bindings ?? bindingsOrNone(deps))()) {
    parents.set(parentDirFor(binding, deps), binding);
  }
  const unregisteredCheckouts = new Map<string, string>();
  if (options.includeUnregistered !== false) {
    const known = new Map<string, Set<string>>();
    for (const binding of parents.values()) {
      if (known.has(binding.checkoutRoot)) continue;
      const paths = await listWorktreePaths(binding.checkoutRoot);
      known.set(binding.checkoutRoot, new Set(paths.map(physicalPath)));
    }
    for (const [parent, binding] of parents) {
      for (const name of readDirs(parent)) {
        const dir = path.join(parent, name);
        if (byPath.has(dir)) continue;
        // A workspace_dir binding points at the operator's own directory,
        // whose other contents are none of the sweep's business: only what
        // git calls a worktree of this checkout is an orphan.
        if (!known.get(binding.checkoutRoot)?.has(physicalPath(dir))) continue;
        unregisteredCheckouts.set(dir, binding.checkoutRoot);
        entries.push(
          classifySweep({
            path: dir,
            branch: name,
            ownerRunId: null,
            ownerTerminal: null,
            keep: false,
            state: "unregistered",
            onDisk: true,
            dirty: await isWorktreeDirty(dir),
            registered: false,
          }),
        );
      }
    }
  }

  // `removed` counts paths reconciled away — a directory deleted, a stale row
  // dropped, or both.
  const removed: string[] = [];
  if (!clean) return { entries, removed, removedDirs: [] };

  const fastForwarded = new Set<string>();
  for (const entry of entries) {
    if (!entry.eligible) continue;
    const row = byPath.get(entry.path);
    const checkoutRoot =
      row?.checkoutRoot ?? unregisteredCheckouts.get(entry.path) ?? "";
    const status =
      row === undefined
        ? "unknown"
        : (owners.get(row.ownerRunId)?.status ?? "unknown");
    // The post-merge half of the fast-forward requirement, and it runs first:
    // whether the branch merged is read off refs/remotes/origin/<default>,
    // which nothing but this fetch refreshes.
    if (
      status === "completed" &&
      checkoutRoot !== "" &&
      !fastForwarded.has(checkoutRoot)
    ) {
      fastForwarded.add(checkoutRoot);
      const result = await ff({ checkoutRoot, enabled: true });
      log(`[sweep] ${describeFf(checkoutRoot, result)}`);
    }
    let plan = decideTeardown({
      keep: row?.keep === true,
      dirty: entry.state === "abandoned-dirty",
      merged:
        status === "completed" &&
        checkoutRoot !== "" &&
        (await isBranchMerged(checkoutRoot, entry.branch)),
    });

    if (plan.preserve !== null) {
      // The marking happens on every clean pass, force or not: preserved
      // wreckage has to be visible in `ps` and `sweep`, not just on disk.
      if (row !== undefined) {
        await setWorktreeState(deps.sql, entry.path, plan.preserve);
      }
      if (!force) continue;
      // --force is the operator overriding the preservation rule by hand; the
      // branches still stay, as they do for any unmerged run.
      plan = DISCARD_TREE;
    }
    if (entry.requiresForce && !force) continue;

    if (entry.state !== "missing" && checkoutRoot !== "") {
      // Neither an unregistered directory nor a half-provisioned tree has a
      // merged branch behind it: the tree goes, the branches stay.
      const branchesStay =
        entry.state === "unregistered" || entry.state === "provision-failed";
      await applyTeardown(branchesStay ? DISCARD_TREE : plan, {
        checkoutRoot,
        worktreePath: entry.path,
        branch: entry.branch,
      });
      // git refuses to remove a directory it never registered as a worktree.
      rmSync(entry.path, { recursive: true, force: true });
    }
    if (row !== undefined) await deleteWorktree(deps.sql, entry.path);
    removed.push(entry.path);
  }

  const removedDirs = removeEmptyWorkspaceDirs(parents.keys());

  const gone = new Set(removed);
  // Known gap: a terminal run that never requested a worktree still leaks its
  // managed Codex home — no pass would ever notice it.
  for (const [runId, state] of owners) {
    if (!state.terminal) continue;
    const held = rows.some(
      (row) => row.ownerRunId === runId && !gone.has(row.path),
    );
    if (!held) removeCodexHome(runId);
  }

  return { entries, removed, removedDirs };
}

function bindingsOrNone(deps: SweepDeps): () => ResolvedBinding[] {
  // A service with no reachable factory config still sweeps what the registry
  // knows; only the unregistered-directory scan needs the binding list.
  return () => {
    try {
      return resolveBindings((deps.factoryRoot ?? factoryRoot)());
    } catch {
      return [];
    }
  };
}

function parentDirFor(binding: ResolvedBinding, deps: SweepDeps): string {
  // workspace_dir short-circuits before the factory root is even needed.
  if (binding.workspaceDir !== undefined) {
    return worktreeParentDir({
      factoryRoot: "",
      bindingName: binding.name,
      workspaceDir: binding.workspaceDir,
    });
  }
  return worktreeParentDir({
    factoryRoot: (deps.factoryRoot ?? factoryRoot)(),
    bindingName: binding.name,
  });
}

// git reports physical toplevels, so a symlinked component has to be resolved
// on both sides before the paths can be compared.
function physicalPath(dir: string): string {
  try {
    return realpathSync(path.resolve(dir));
  } catch {
    return path.resolve(dir);
  }
}

function readDirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

// Only the per-binding parents, never the base: an empty <binding>/ left
// behind after the last worktree is noise, but the workspace root is the
// operator's.
function removeEmptyWorkspaceDirs(parents: Iterable<string>): string[] {
  const candidates = new Set<string>(parents);
  const gone: string[] = [];
  for (const dir of candidates) {
    try {
      rmdirSync(dir);
      gone.push(dir);
    } catch {
      // not empty, or never existed
    }
  }
  return gone;
}
