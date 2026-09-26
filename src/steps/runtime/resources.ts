import { getWorkflowMetadata } from "workflow";
import { getRun } from "workflow/api";
import { getWorld } from "workflow/runtime";
import { JigsError } from "../../errors.ts";
import type { RunResource } from "../../workflow/runtime/resources.ts";
import { currentFactory, recordResource, registrySql } from "./registry.ts";
import type { WorldRunFacts } from "./run-state.ts";

function assertResource(resource: RunResource): void {
  for (const field of ["kind", "identity", "url"] as const) {
    const value = resource[field];
    if (value.length === 0) throw new JigsError(`resource ${field} must not be empty`);
    if (!value.isWellFormed()) throw new JigsError(`resource ${field} must contain valid Unicode`);
  }
  if (!URL.canParse(resource.url)) {
    throw new JigsError(`resource URL is not an absolute URL: ${JSON.stringify(resource.url)}`);
  }
}

/**
 * Register one resource on the active run.
 *
 * Repeating kind + identity is idempotent. A new URL for that identity replaces the old one and
 * marks the record live again. Kinds jigs knows how to release (`worktree`, `run-directory`,
 * `branch`, `codex-home`, `pi-home`) are released with the run; every other kind is recorded only.
 *
 * @group Recorded resources
 */
export async function registerResource(resource: RunResource): Promise<RunResource> {
  assertResource(resource);
  await recordResource(registrySql(), {
    factory: currentFactory(),
    runId: getWorkflowMetadata().workflowRunId,
    kind: resource.kind,
    identity: resource.identity,
    url: resource.url,
  });
  return resource;
}

/** The World's side of {@link readRunState}, for code running in the service. */
export async function worldRunFacts(runId: string): Promise<WorldRunFacts> {
  const run = getRun(runId);
  if (!(await run.exists)) return { status: null, workflowName: null, tokens: [] };
  const [status, workflowName, hooks] = await Promise.all([
    run.status,
    run.workflowName,
    getWorld().then((world) => world.hooks.list({ runId })),
  ]);
  return { status, workflowName, tokens: hooks.data.map((hook) => hook.token) };
}
