import {
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
// acquire and register the tree, then provision it from the target repo's
// .jigs.yml.

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
  const target = worktreePath({
    factoryRoot: factoryRoot(),
    bindingName: binding.name,
    branch: request.branch,
  });

  const facts = await (deps.acquire ?? acquireWorktree)(
    {
      runId: request.runId,
      checkoutRoot: binding.checkoutRoot,
      worktreePath: target,
      branch: request.branch,
      ...(request.keep === undefined ? {} : { keep: request.keep }),
    },
    { sql },
  );

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
  log(
    `[worktree] provisioned binding=${binding.name} branch=${facts.branch} path=${facts.path}`,
  );
  return facts;
}
