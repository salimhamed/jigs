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

import {
  type Binding,
  bindingRepoDir,
  CliError,
  hasBindingClone,
  resolveBinding,
  type WorktreeFacts,
  worktreePath,
} from "jigs";
import type { Sql } from "postgres";
import { factoryRoot } from "../preflight";
import { createWorktree, worktreeStatus } from "./create";
import { readOwner } from "./owner";
import { provisionWorktree } from "./provision";
import { getWorktree, setWorktreeState, upsertWorktree } from "./registry";
import { assertReusable, WorktreeOwnedError } from "./reuse";
import { registrySql } from "./sql";
import { teardownRun } from "./teardown";

export interface WorktreeRequest {
  binding: string;
  branch: string;
  keep?: boolean;
}

export class WorktreeRegistryUnavailableError extends Error {
  constructor() {
    super(
      "worktree registry unavailable: WORKFLOW_POSTGRES_URL is not configured",
    );
    this.name = "WorktreeRegistryUnavailableError";
  }
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
  if (sql === null) throw new WorktreeRegistryUnavailableError();
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

  // Per-path advisory lock: without it, two concurrent requests for the same
  // unowned path both read no live owner during the (fetch-long) window
  // between getWorktree and upsertWorktree, and the loser silently steals
  // ownership. The loser now blocks here, then sees the winner's row.
  const facts = await sql.begin(async (sql): Promise<WorktreeFacts> => {
    await sql`SELECT pg_advisory_xact_lock(hashtext(${target}))`;

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
            resolution: "local",
            defaultBranch: disk.defaultBranch,
            baseSha: disk.baseSha,
            headSha: disk.headSha,
            behindDefault: disk.behindDefault,
          };

    await upsertWorktree(sql, {
      path: facts.path,
      branch: facts.branch,
      ownerRunId: runId,
      state: "active",
      baseSha: facts.baseSha,
      headSha: facts.headSha,
      behindDefault: facts.behindDefault,
      repoDir,
      keep: request.keep === true,
    });
    return facts;
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

// The per-run half of the teardown matrix, called by the pipeline after a
// merged reviewLoop return. The operator's `jigs sweep` is the net for runs
// that never get there.
export async function teardownRunWorktrees(
  runId: string,
  outcome: { merged: boolean },
): Promise<string[]> {
  const sql = registrySql();
  if (sql === null) return [];
  return teardownRun(runId, outcome, { sql });
}
