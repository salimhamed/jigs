import { existsSync, rmdirSync, rmSync } from "node:fs";
import path from "node:path";
import {
  applyTeardown,
  classifySweep,
  decideTeardown,
  fetchOriginDefault,
  isBranchMerged,
  isWorktreeDirty,
  removeManagedCodexHome,
  type SweepEntry,
} from "jigs";
import type { Sql } from "postgres";
import { type OwnerState, readOwner } from "./acquire";
import {
  deleteWorktree,
  listWorktrees,
  setWorktreeState,
  type WorktreeRow,
} from "./registry";

// The one disk-against-registry-against-run-states join, behind both `jigs
// sweep` and the worktree table `jigs ps` renders. Nothing runs it unattended:
// the SDK exposes no run-completion callback, a workflow-body `finally` fires
// on every suspension (WorkflowSuspension is a thrown Error), and a background
// timer was rejected as a surprise — so leftovers stay visible until an
// operator acts, and the teardown matrix falls out of the classifier.

// Remove the tree, keep both branches: what a discard with no merge behind it
// looks like, whether the tree was dirty or half-provisioned.
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
  // A clean scoped to operator-approved worktrees: only entries whose path is
  // listed are acted on. Absent means every eligible entry.
  paths?: string[];
}

export interface SweepDeps {
  sql: Sql;
  readOwner?: (runId: string) => Promise<OwnerState>;
  fetchDefault?: typeof fetchOriginDefault;
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
  const fetchDefault = deps.fetchDefault ?? fetchOriginDefault;
  const removeCodexHome = deps.removeCodexHome ?? removeManagedCodexHome;
  const log = deps.log ?? ((line: string) => console.log(line));

  const rows = await listWorktrees(deps.sql);
  const owners = new Map<string, OwnerState>();
  for (const row of rows) {
    if (!owners.has(row.ownerRunId)) {
      owners.set(row.ownerRunId, await owner(row.ownerRunId));
    }
  }

  const classified: Array<{ row: WorktreeRow; entry: SweepEntry }> = [];
  for (const row of rows) {
    const onDisk = existsSync(row.path);
    classified.push({
      row,
      entry: classifySweep({
        path: row.path,
        branch: row.branch,
        ownerRunId: row.ownerRunId,
        ownerTerminal: owners.get(row.ownerRunId)?.terminal ?? true,
        keep: row.keep,
        state: row.state,
        onDisk,
        dirty: onDisk ? await isWorktreeDirty(row.path) : false,
      }),
    });
  }
  const entries = classified.map((item) => item.entry);

  // `removed` counts paths reconciled away — a directory deleted, a stale row
  // dropped, or both.
  const removed: string[] = [];
  if (!clean) return { entries, removed, removedDirs: [] };

  const approved = options.paths === undefined ? null : new Set(options.paths);
  const fetched = new Set<string>();
  for (const { row, entry } of classified) {
    if (!entry.eligible) continue;
    if (approved !== null && !approved.has(entry.path)) continue;
    const { checkoutRoot } = row;
    const status = owners.get(row.ownerRunId)?.status ?? "unknown";
    // The merge check below reads refs/remotes/origin/<default>, and nothing
    // else refreshes it. A failure is a notice, never the end of the pass:
    // trees earlier in the loop are already gone, and the stale ref reads
    // unmerged, which keeps the branch as insurance.
    if (
      status === "completed" &&
      checkoutRoot !== "" &&
      !fetched.has(checkoutRoot)
    ) {
      fetched.add(checkoutRoot);
      try {
        await fetchDefault(checkoutRoot);
      } catch (err) {
        log(
          `[sweep] could not fetch the default branch of ${checkoutRoot}: ${String(err)}`,
        );
      }
    }
    const merged =
      status === "completed" &&
      checkoutRoot !== "" &&
      (await isBranchMerged(checkoutRoot, entry.branch));
    let plan = decideTeardown({
      keep: row.keep,
      dirty: entry.state === "abandoned-dirty",
      merged,
    });

    if (plan.preserve !== null) {
      // The marking happens on every clean pass, force or not: preserved
      // wreckage has to be visible in `ps` and `sweep`, not just on disk.
      await setWorktreeState(deps.sql, entry.path, plan.preserve);
      if (!force) continue;
      // --force is the operator overriding the preservation rule by hand; the
      // branches still stay, as they do for any unmerged run.
      plan = DISCARD_TREE;
    }
    // An untracked file is enough to read as dirty, so without the merged
    // exemption the matrix's headline row — done and merged — would need
    // --force. Scoped to abandoned-dirty: a provision-failed tree reads as
    // merged for want of commits of its own, and it is the diagnosis evidence
    // ADR 0007 preserves.
    const mergedOverride = merged && entry.state === "abandoned-dirty";
    if (entry.requiresForce && !force && !mergedOverride) continue;

    if (entry.state !== "missing" && checkoutRoot !== "") {
      // A half-provisioned tree has no merged branch behind it: the tree goes,
      // the branches stay.
      const branchesStay = entry.state === "provision-failed";
      await applyTeardown(branchesStay ? DISCARD_TREE : plan, {
        checkoutRoot,
        worktreePath: entry.path,
        branch: entry.branch,
      });
      // git refuses to remove a directory it never registered as a worktree.
      rmSync(entry.path, { recursive: true, force: true });
    }
    await deleteWorktree(deps.sql, entry.path);
    removed.push(entry.path);
  }

  const removedDirs = removeEmptyParentDirs(
    new Set(rows.map((row) => path.dirname(row.path))),
  );

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

// Only the directories the swept rows sat directly in, never anything above
// them.
function removeEmptyParentDirs(parents: Iterable<string>): string[] {
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
