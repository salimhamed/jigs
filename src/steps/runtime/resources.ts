import { getWorkflowMetadata } from "workflow";
import { JigsError } from "../../errors.ts";
import { type RunResource, releasable } from "../../workflow/runtime/resources.ts";
import { currentFactory, recordResource, registrySql } from "./registry.ts";

function assertResource(resource: RunResource): void {
  for (const field of ["kind", "identity", "url"] as const) {
    const value = resource[field];
    if (value.length === 0) throw new JigsError(`resource ${field} must not be empty`);
    if (!value.isWellFormed()) throw new JigsError(`resource ${field} must contain valid Unicode`);
  }
  if (!URL.canParse(resource.url)) {
    throw new JigsError(`resource URL is not an absolute URL: ${JSON.stringify(resource.url)}`);
  }
  if (releasable(resource.kind)) {
    throw new JigsError(
      `resource kind ${resource.kind} is reserved: jigs records and releases it itself`,
      "register what your workflow created under a kind of its own, such as report or deployment",
    );
  }
}

/**
 * Register one resource on the active run so `jigs status` shows it.
 *
 * Repeating kind + identity is idempotent; a new URL for that identity replaces the old one.
 * The record is observation only: it stays `live` as the run's history and jigs never deletes
 * what it names. The kinds jigs releases itself (`worktree`, `run-directory`, `branch`,
 * `codex-home`, `pi-home`) are reserved.
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
