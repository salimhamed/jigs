import type { FactoryDefinition } from "../../workflow/factory.ts";
import type { ReleasePolicy, ReleaseReport } from "../../workflow/runtime/release.ts";
import type { ResourceRecord } from "../../workflow/runtime/resources.ts";
import {
  currentFactory,
  listResources,
  type RegistrySql,
  registrySql,
  setResourceState,
  toRecord,
  withRunResourceLock,
} from "./registry.ts";
import { resolveReleasePolicy } from "./release-policy.ts";
import { releasable, releaseOrder, releaseResource } from "./resource-kinds.ts";
import type { NamedRunMetadata } from "./run-context.ts";

/**
 * Apply one release decision to a run's live and failed resources and return every record.
 * Explicit and automatic release both call this while holding the run's resource lock.
 */
export async function releaseRun(
  db: RegistrySql,
  factory: string,
  runId: string,
  action: "release" | "keep",
  keepReason: string,
): Promise<ResourceRecord[]> {
  const rows = await listResources(db, { factory, runId });
  const pending = rows.filter(
    (row) => releasable(row.kind) && (row.state === "live" || row.state === "failed"),
  );
  for (const row of releaseOrder(pending)) {
    const outcome =
      action === "keep"
        ? { state: "kept" as const, reason: keepReason }
        : await releaseResource(row, rows);
    // Later kinds read this run's states as they stand, not as they were read.
    row.state = outcome.state;
    await setResourceState(db, row, outcome.state, outcome.reason);
  }
  return (await listResources(db, { factory, runId })).map(toRecord);
}

/**
 * Release this run's resources on its success path and return what was removed or kept.
 *
 * @remarks
 * Without a policy, uses the workflow's `release`, then the factory's, then the default of
 * releasing successful runs and keeping failed ones. Kept records are final: automatic release
 * after the run ends only visits records that are still live or failed.
 *
 * @group Release
 */
export async function releaseRunResources(
  metadata: NamedRunMetadata,
  definition: FactoryDefinition,
  explicit?: ReleasePolicy,
): Promise<ReleaseReport> {
  const policy = explicit ?? (await resolveReleasePolicy(metadata, definition));
  const runId = metadata.workflowRunId;
  const resources = await withRunResourceLock(registrySql(), runId, (locked) =>
    releaseRun(
      locked,
      currentFactory(),
      runId,
      policy.onSuccess,
      "onSuccess policy keeps run resources",
    ),
  );
  return { policy, resources };
}
