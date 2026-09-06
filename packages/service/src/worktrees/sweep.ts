import { existsSync, rmdirSync, rmSync } from "node:fs";
import path from "node:path";
import { removeManagedCodexHome } from "jigs";
import type { Sql } from "postgres";
import { fetchOriginDefault } from "./create";
import { type OwnerState, readOwner } from "./owner";
import {
  deleteWorktree,
  listWorktrees,
  setWorktreeState,
  type WorktreeRow,
} from "./registry";
import {
  applyTeardown,
  decideTeardown,
  isBranchMerged,
  isWorktreeDirty,
} from "./teardown";

// The one disk-against-registry-against-run-states join, behind both `jigs
// sweep` and the worktree table `jigs ps` renders. Nothing runs it unattended:
// the SDK exposes no run-completion callback, a workflow-body `finally` fires
// on every suspension (WorkflowSuspension is a thrown Error), and a background
// timer was rejected as a surprise — so leftovers stay visible until an
// operator acts, and the teardown matrix falls out of the classifier.

// The classifier is pure, zero IO, so every rule in ADR 0007's reconciliation
// is a table test; sweepWorktrees below gathers the facts (registry rows, run
// states, disk) and acts on the verdict.

export type SweepState =
  | "held"
  | "kept"
  | "abandoned"
  | "abandoned-dirty"
  | "provision-failed"
  | "missing";

export interface SweepInput {
  path: string;
  branch: string;
  ownerRunId: string;
  ownerTerminal: boolean;
  keep: boolean;
  state: string;
  onDisk: boolean;
  dirty: boolean;
}

export interface SweepEntry {
  path: string;
  branch: string;
  state: SweepState;
  eligible: boolean;
  requiresForce: boolean;
  ownerRunId?: string;
  reason: string;
}

export function classifySweep(input: SweepInput): SweepEntry {
  const base = {
    path: input.path,
    branch: input.branch,
    ownerRunId: input.ownerRunId,
  };

  if (!input.onDisk) {
    return {
      ...base,
      state: "missing",
      eligible: true,
      requiresForce: false,
      reason: "registered but gone from disk — the row is stale",
    };
  }
  if (input.keep) {
    return {
      ...base,
      state: "kept",
      eligible: false,
      requiresForce: false,
      reason: "keep: true was requested",
    };
  }
  // The SDK reads a parked run as `running`, so non-terminal covers live and
  // suspended owners alike: a suspended run keeps its worktree. It outranks
  // provision-failed, a state a live run sits in whenever the worktree()
  // request is retried or its rejection caught.
  if (!input.ownerTerminal) {
    return {
      ...base,
      state: "held",
      eligible: false,
      requiresForce: false,
      reason: "the owning run is still live or suspended",
    };
  }
  if (input.state === "provision-failed") {
    // The half-provisioned tree is the diagnosis evidence ADR 0007 preserves;
    // its owning run failed immediately, so without this the automatic pass
    // would delete the evidence within a minute.
    return {
      ...base,
      state: "provision-failed",
      eligible: true,
      requiresForce: true,
      reason: "provisioning failed — kept for diagnosis",
    };
  }
  if (input.dirty) {
    return {
      ...base,
      state: "abandoned-dirty",
      eligible: true,
      requiresForce: true,
      reason: "the owning run is terminal and the tree has uncommitted work",
    };
  }
  return {
    ...base,
    state: "abandoned",
    eligible: true,
    requiresForce: false,
    reason: "the owning run is terminal and the tree is clean",
  };
}

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
    const { repoDir } = row;
    const status = owners.get(row.ownerRunId)?.status ?? "unknown";
    // The merge check below reads refs/remotes/origin/<default>, and nothing
    // else refreshes it. A failure is a notice, never the end of the pass:
    // trees earlier in the loop are already gone, and the stale ref reads
    // unmerged, which keeps the branch as insurance.
    if (status === "completed" && !fetched.has(repoDir)) {
      fetched.add(repoDir);
      try {
        await fetchDefault(repoDir);
      } catch (err) {
        log(
          `[sweep] could not fetch the default branch of ${repoDir}: ${String(err)}`,
        );
      }
    }
    const merged =
      status === "completed" && (await isBranchMerged(repoDir, entry.branch));
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

    if (entry.state !== "missing") {
      // A half-provisioned tree has no merged branch behind it: the tree goes,
      // the branches stay.
      const branchesStay = entry.state === "provision-failed";
      await applyTeardown(branchesStay ? DISCARD_TREE : plan, {
        repoDir,
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
