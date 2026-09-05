import {
  type Binding,
  bindingRepoDir,
  CliError,
  hasBindingClone,
  locateFactoryRoot,
  provisionWorktree,
  resolveBinding,
  type WorktreeFacts,
  worktreePath,
} from "jigs";
import type { Sql } from "postgres";
import { acquireWorktree } from "./acquire";
import { setWorktreeState } from "./registry";
import { registrySql } from "./sql";

// The step side of the pipeline's worktree() request: resolve the binding,
// acquire and register the tree, then provision it as the binding describes.
// The clone is the service's to make at start, so this path only asserts it.

export function factoryRoot(): string {
  const override = process.env.JIGS_FACTORY_ROOT;
  if (override !== undefined && override !== "") return override;
  return locateFactoryRoot(process.cwd());
}

export class WorktreeRegistryUnavailableError extends Error {
  constructor() {
    super(
      "worktree registry unavailable: WORKFLOW_POSTGRES_URL is not configured",
    );
    this.name = "WorktreeRegistryUnavailableError";
  }
}

export interface ProvisionRequest {
  runId: string;
  binding: string;
  branch: string;
  keep?: boolean;
}

export interface ProvisionRequestDeps {
  sql?: Sql;
  resolveBinding?: (name: string) => Binding;
  acquire?: typeof acquireWorktree;
  provision?: typeof provisionWorktree;
  log?: (line: string) => void;
}

export async function provisionRequest(
  request: ProvisionRequest,
  deps: ProvisionRequestDeps = {},
): Promise<WorktreeFacts> {
  const sql = deps.sql ?? registrySql();
  if (sql === null) throw new WorktreeRegistryUnavailableError();
  const resolve =
    deps.resolveBinding ??
    ((name: string) => resolveBinding(factoryRoot(), name));
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

  const facts = await (deps.acquire ?? acquireWorktree)(
    {
      runId: request.runId,
      repoDir,
      worktreePath: target,
      branch: request.branch,
      ...(request.keep === undefined ? {} : { keep: request.keep }),
    },
    { sql },
  );

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
