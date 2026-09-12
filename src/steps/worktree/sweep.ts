import { existsSync, rmdirSync, rmSync } from "node:fs";
import path from "node:path";
import type { Sql } from "postgres";
import { TERMINAL_RUN_STATUSES } from "../../run-status.ts";
import { removeManagedCodexHome } from "../agent/harnesses/codex-home.ts";
import { fetchOriginDefault } from "./create.ts";
import { type OwnerState, readOwner } from "./owner.ts";
import { deleteWorktree, listWorktrees, setWorktreeState, type WorktreeRow } from "./registry.ts";
import {
  applyTeardown,
  countUnmergedCommits,
  decideTeardown,
  isWorktreeDirty,
} from "./teardown.ts";

// The one disk-against-registry-against-run-states join, behind both `jigs
// sweep` and the worktree table `jigs ps` renders. Nothing runs it unattended:
// the SDK exposes no run-completion callback, a workflow-body `finally` fires
// on every suspension (WorkflowSuspension is a thrown Error), and a background
// timer was rejected as a surprise — so leftovers stay visible until an
// operator acts, and the teardown matrix falls out of the classifier.

// The classifier is pure, zero IO, so every reconciliation rule is a table
// test; sweepWorktrees below gathers the facts (registry rows, run states,
// disk) and acts on the verdict.

export type SweepState = "held" | "abandoned" | "abandoned-dirty" | "provision-failed" | "missing";

export interface SweepInput {
  path: string;
  branch: string;
  ownerRunId: string;
  ownerTerminal: boolean;
  state: string;
  onDisk: boolean;
  dirty: boolean;
}

// What became of the branch of a worktree this pass removed. Absent until a
// removal decides: a held entry, a report-only pass, and a stale row whose
// branch nothing touched all leave it unset.
export interface BranchOutcome {
  deleted: boolean;
  // Absent when the ancestry question went unasked or unanswered.
  unmergedCommits?: number;
}

export interface SweepEntry {
  path: string;
  branch: string;
  state: SweepState;
  eligible: boolean;
  requiresForce: boolean;
  ownerRunId?: string;
  reason: string;
  branchOutcome?: BranchOutcome;
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
    // The half-provisioned tree is diagnosis evidence: its owning run failed
    // immediately, so without this the automatic pass would delete the
    // evidence within a minute.
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

// `readOwner` reaches the World, the one external system this pass consults
// that a test cannot stand up on disk.
export interface SweepDeps {
  sql: Sql;
  readOwner?: (runId: string) => Promise<OwnerState>;
}

export interface SweepReport {
  entries: SweepEntry[];
  removed: string[];
  removedDirs: string[];
}

export async function sweepWorktrees(options: SweepOptions, deps: SweepDeps): Promise<SweepReport> {
  const clean = options.clean === true;
  const force = options.force === true;
  const owner = deps.readOwner ?? readOwner;

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
    const dirtyTree = entry.state === "abandoned-dirty";
    // A branch origin's default branch already contains is a copy of nothing
    // however the run ended, so the ancestry question is asked of every
    // terminal status — including the empty branch of a run cancelled before
    // its first commit, whose tip is still the fork point. A status the World
    // no longer knows is not one of them: branch deletion needs positive
    // evidence. A dirty tree is asked only when the run completed, where the
    // merged exemption below is the done row's; elsewhere the uncommitted
    // work is what the dirty guard is holding.
    const askMerged = TERMINAL_RUN_STATUSES.has(status) && (status === "completed" || !dirtyTree);
    // The merge check below reads refs/remotes/origin/<default>, and nothing
    // else refreshes it. A failure is a notice, never the end of the pass:
    // trees earlier in the loop are already gone, and the stale ref reads
    // unmerged, which keeps the branch as insurance.
    if (askMerged && !fetched.has(repoDir)) {
      fetched.add(repoDir);
      try {
        await fetchOriginDefault(repoDir);
      } catch (err) {
        console.log(`[sweep] could not fetch the default branch of ${repoDir}: ${String(err)}`);
      }
    }
    const unmerged = askMerged ? await countUnmergedCommits(repoDir, entry.branch) : null;
    const merged = unmerged === 0;
    let plan = decideTeardown({ dirty: dirtyTree, merged });
    // Only a completed run's teardown reaches the remote. A cancelled or
    // failed run's pushed branch is somebody's open PR whatever its ancestry,
    // and an empty branch was never pushed at all.
    if (status !== "completed") plan = { ...plan, deleteRemoteBranch: false };

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
    // the provision-failed rule keeps.
    const mergedOverride = merged && entry.state === "abandoned-dirty";
    if (entry.requiresForce && !force && !mergedOverride) continue;

    if (entry.state !== "missing") {
      // A half-provisioned tree has no merged branch behind it: the tree goes,
      // the branches stay.
      const branchesStay = entry.state === "provision-failed";
      const applied = branchesStay ? DISCARD_TREE : plan;
      await applyTeardown(applied, {
        repoDir,
        worktreePath: entry.path,
        branch: entry.branch,
      });
      // git refuses to remove a directory it never registered as a worktree.
      rmSync(entry.path, { recursive: true, force: true });
      entry.branchOutcome = {
        deleted: applied.deleteLocalBranch,
        ...(unmerged === null ? {} : { unmergedCommits: unmerged }),
      };
    }
    await deleteWorktree(deps.sql, entry.path);
    removed.push(entry.path);
  }

  const removedDirs = removeEmptyParentDirs(new Set(rows.map((row) => path.dirname(row.path))));

  const gone = new Set(removed);
  // Known gap: a terminal run that never requested a worktree still leaks its
  // managed Codex home — no pass would ever notice it.
  for (const [runId, state] of owners) {
    if (!state.terminal) continue;
    const held = rows.some((row) => row.ownerRunId === runId && !gone.has(row.path));
    if (!held) removeManagedCodexHome(runId);
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
