import {
  type Binding,
  bindingRepoDir,
  bindingSeedDir,
  DEFAULT_WORKTREE_CONFIG,
  ensureBindingClone,
  locateFactoryRoot,
  provisionWorktree,
  resolveBinding,
  resolveWorktreeConfig,
  type WorktreeFacts,
  worktreePath,
} from "jigs";
import type { Sql } from "postgres";
import { acquireWorktree } from "./acquire";
import { setWorktreeState } from "./registry";
import { registrySql } from "./sql";

// The step side of the pipeline's worktree() request: resolve the binding,
// make sure its clone exists, acquire and register the tree, then provision it
// from the seed directory or the target repo's own .jigs.yml.

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
  ensureClone?: typeof ensureBindingClone;
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
  const ensureClone = deps.ensureClone ?? ensureBindingClone;
  const provision = deps.provision ?? provisionWorktree;
  const log = deps.log ?? ((line: string) => console.log(line));

  const binding = resolve(request.binding);
  const dirs = { factoryRoot: factoryRoot(), bindingName: binding.name };
  const repoDir = bindingRepoDir(dirs);
  const seedDir = bindingSeedDir(dirs);
  const target = worktreePath({ ...dirs, branch: request.branch });

  // Lazily, on the first request of this binding: both the reuse check and
  // the cut read the clone.
  await ensureClone({ repoDir, remote: binding.remote });

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

  const resolved = resolveWorktreeConfig({
    seedDir,
    worktreePath: facts.path,
  });
  if (resolved === null) {
    log(
      `[worktree] no .jigs.yml in ${seedDir} or the worktree — copying nothing, running nothing`,
    );
  }
  try {
    await provision({
      seedDir,
      worktreePath: facts.path,
      config: resolved ?? DEFAULT_WORKTREE_CONFIG,
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
