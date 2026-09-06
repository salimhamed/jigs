// The step side of the worktree lifecycle: what the factory's "use step"
// wrappers delegate to. The runtime creates a worktree and registers it; the
// pipeline calls teardown as a plain sequential line after a merged
// reviewLoop return — never in a `finally`, which would fire on every
// suspension, and a suspended run keeps its worktree. Every other ending
// leaves the tree for the operator's `jigs sweep`.
//
// Everything below reaches node builtins, so this module must only ever be
// imported from inside a step body. `WorktreeRequest` is a type, so a
// workflow-side `import type` of it is erased and stays safe.

import type { Sql } from "postgres";
import { type Binding, resolveBinding } from "../config/factory-config.ts";
import { factoryRoot } from "../config/factory-root.ts";
import { CliError } from "../errors.ts";
import { hasBindingClone } from "./clone.ts";
import { createWorktree, worktreeStatus } from "./create.ts";
import type { WorktreeFacts } from "./facts.ts";
import { bindingRepoDir, worktreePath } from "./layout.ts";
import { readOwner } from "./owner.ts";
import { provisionWorktree } from "./provision.ts";
import { getWorktree, setWorktreeState, upsertWorktree } from "./registry.ts";
import { assertReusable, WorktreeOwnedError } from "./reuse.ts";
import { registrySql } from "./sql.ts";
import { teardownMergedRun as teardownMerged } from "./teardown.ts";

export interface WorktreeRequest {
  binding: string;
  branch: string;
}

export interface ProvisionRunWorktreeDeps {
  sql?: Sql;
  resolveBinding?: (name: string) => Binding;
  runIsLive?: (runId: string) => Promise<boolean>;
  worktreeStatus?: typeof worktreeStatus;
  createWorktree?: typeof createWorktree;
  provision?: typeof provisionWorktree;
  log?: (line: string) => void;
}

async function runIsLive(runId: string): Promise<boolean> {
  return !(await readOwner(runId)).terminal;
}

// The clone is the service's to make at start, so this path only asserts it.
export async function provisionRunWorktree(
  request: WorktreeRequest,
  runId: string,
  deps: ProvisionRunWorktreeDeps = {},
): Promise<WorktreeFacts> {
  const sql = deps.sql ?? registrySql();
  const resolve =
    deps.resolveBinding ??
    ((name: string) => resolveBinding(factoryRoot(), name));
  const isLive = deps.runIsLive ?? runIsLive;
  const status = deps.worktreeStatus ?? worktreeStatus;
  const create = deps.createWorktree ?? createWorktree;
  const provision = deps.provision ?? provisionWorktree;
  const log = deps.log ?? ((line: string) => console.log(line));

  const binding = resolve(request.binding);
  const dirs = { factoryRoot: factoryRoot(), bindingName: binding.name };
  const repoDir = bindingRepoDir(dirs);
  const target = worktreePath({ ...dirs, branch: request.branch });

  // Only reachable when the binding was declared after this service booted:
  // both the reuse check and the cut read a clone that is not there.
  if (!hasBindingClone(repoDir)) {
    throw new CliError(
      `binding ${binding.name} has no clone at ${repoDir}`,
      "restart the service: jigs service restart (it clones every binding on start)",
    );
  }

  // Unserialized on purpose: the ticket claim admits one active run per
  // ticket and this path derives from that ticket's branch, so no second run
  // can be requesting it.
  const row = await getWorktree(sql, target);
  const sameOwner = row?.ownerRunId === runId;
  // Refuse before touching disk: worktreeStatus fetches, and a foreign live
  // owner should never surface as a network error or pay for the fetch.
  if (row !== null && !sameOwner && (await isLive(row.ownerRunId))) {
    throw new WorktreeOwnedError(target, row.ownerRunId);
  }

  const cut = { repoDir, worktreePath: target, branch: request.branch };
  const disk = await status(cut);
  // A registry row with no directory is just a branch with no worktree —
  // fall through to three-way resolution.
  if (disk !== null) assertReusable({ path: target, sameOwner, disk });
  const facts: WorktreeFacts =
    disk === null
      ? await create(cut)
      : {
          path: target,
          branch: request.branch,
          defaultBranch: disk.defaultBranch,
          baseSha: disk.baseSha,
        };

  await upsertWorktree(sql, {
    path: facts.path,
    branch: facts.branch,
    ownerRunId: runId,
    state: "active",
    repoDir,
  });

  try {
    await provision({
      binding,
      factoryRoot: dirs.factoryRoot,
      worktreePath: facts.path,
    });
  } catch (err) {
    // The half-provisioned tree stays on disk, marked for diagnosis: an agent
    // building in it would produce expensive garbage.
    await setWorktreeState(sql, facts.path, "provision-failed");
    throw err;
  }
  log(
    `[worktree] provisioned binding=${binding.name} branch=${facts.branch} path=${facts.path}`,
  );
  return facts;
}

// The per-run teardown, called by the pipeline after a merged reviewLoop
// return. The operator's `jigs sweep` is the net for runs that never get
// there.
export async function teardownMergedRun(runId: string): Promise<string[]> {
  return teardownMerged(runId, { sql: registrySql() });
}

// The name the factories' steps/jigs.ts wrappers still import. The review
// loop only returns merged, so `outcome` was always `{ merged: true }`; this
// goes once the wrappers call teardownMergedRun directly. The guard keeps a
// stray `{ merged: false }` from deleting the only copy of unmerged work now
// that the flag no longer chooses a row.
export function teardownRunWorktrees(
  runId: string,
  outcome: { merged: boolean },
): Promise<string[]> {
  if (!outcome.merged) {
    throw new Error(
      "teardownRunWorktrees only tears down merged runs; unmerged worktrees are reclaimed by `jigs sweep`",
    );
  }
  return teardownMergedRun(runId);
}
