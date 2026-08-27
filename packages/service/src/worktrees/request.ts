import {
  describeFf,
  fastForwardDefaultBranch,
  locateFactoryRoot,
  provisionWorktree,
  type ResolvedBinding,
  readTargetConfig,
  resolveBinding,
  type WorktreeFacts,
  worktreePath,
} from "jigs";
import type { Sql } from "postgres";
import { acquireWorktree } from "./acquire";
import { setWorktreeState } from "./registry";
import { registrySql } from "./sql";

// The step side of the pipeline's worktree() request: resolve the binding,
// acquire and register the tree, refresh the checkout's default branch, then
// provision it from the target repo's .jigs.yml.

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
  resolveBinding?: (name: string) => ResolvedBinding;
  acquire?: typeof acquireWorktree;
  fastForward?: typeof fastForwardDefaultBranch;
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
  const ff = deps.fastForward ?? fastForwardDefaultBranch;
  const provision = deps.provision ?? provisionWorktree;
  const log = deps.log ?? ((line: string) => console.log(line));

  const binding = resolve(request.binding);
  const target = worktreePath({
    factoryRoot: factoryRoot(),
    bindingName: binding.name,
    branch: request.branch,
    ...(binding.workspaceDir === undefined
      ? {}
      : { workspaceDir: binding.workspaceDir }),
  });

  const facts = await (deps.acquire ?? acquireWorktree)(
    {
      runId: request.runId,
      checkoutRoot: binding.checkoutRoot,
      worktreePath: target,
      branch: request.branch,
      binding: binding.name,
      ...(request.keep === undefined ? {} : { keep: request.keep }),
    },
    { sql },
  );

  // Activation freshness: a notice either way, never a failure.
  const result = await ff({
    checkoutRoot: binding.checkoutRoot,
    enabled: binding.ffDefaultBranch,
  });
  log(`[worktree] ${describeFf(binding.checkoutRoot, result)}`);

  try {
    await provision({
      checkoutRoot: binding.checkoutRoot,
      worktreePath: facts.path,
      config: readTargetConfig(binding.checkoutRoot).worktree,
    });
  } catch (err) {
    // The half-provisioned tree stays on disk, marked for diagnosis: an agent
    // building in it would produce expensive garbage.
    await setWorktreeState(sql, facts.path, "provision-failed");
    throw err;
  }
  return facts;
}
