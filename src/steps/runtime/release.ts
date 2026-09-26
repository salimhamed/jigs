import type { FactoryDefinition } from "../../workflow/factory.ts";
import type {
  ReleaseAction,
  ReleasePolicy,
  ReleaseReport,
  RunOutcome,
} from "../../workflow/runtime/release.ts";
import type { ResourceRecord } from "../../workflow/runtime/resources.ts";
import {
  currentFactory,
  listResources,
  type RegistrySql,
  type ResourceRow,
  registrySql,
  setResourceState,
  toRecord,
  withRunResourceLock,
} from "./registry.ts";
import { resolveReleasePolicy } from "./release-policy.ts";
import { decideRelease, type ReleaseDecision, releaseOrder } from "./resource-kinds.ts";
import type { NamedRunMetadata } from "./run-context.ts";

/** Failed attempts after which a resource is kept with its last error instead of retried. */
export const MAX_RELEASE_ATTEMPTS = 5;

/**
 * Whether a resource is due for release now. A failed one waits 2^attempts minutes (at most an
 * hour) after its last attempt, so an outage does not use up its attempts in a few passes.
 */
export function releaseDue(
  row: Pick<ResourceRow, "state" | "attempts" | "updatedAt">,
  now = new Date(),
): boolean {
  if (row.state === "live") return true;
  if (row.state !== "failed") return false;
  return now.getTime() - row.updatedAt.getTime() >= Math.min(2 ** row.attempts, 60) * 60_000;
}

export const keepReason = (outcome: RunOutcome): string =>
  `${outcome === "success" ? "onSuccess" : "onFailure"} policy keeps run resources`;

/**
 * Release one resource and record what happened. `run` is every row of the same run; the row is
 * updated in place so kinds visited later read its new state. A removal that throws is `failed`,
 * and the {@link MAX_RELEASE_ATTEMPTS}th failure is kept with its error. Release and prune both
 * write through here, holding the run's lock.
 */
export async function releaseOne(
  db: RegistrySql,
  row: ResourceRow,
  run: readonly ResourceRow[],
  decision?: ReleaseDecision,
): Promise<ResourceRow> {
  let attempts = 0;
  let outcome: Pick<ResourceRow, "state" | "reason">;
  try {
    const decided = decision ?? (await decideRelease(row, run));
    outcome = typeof decided === "function" ? await decided() : decided;
  } catch (error) {
    attempts = row.attempts + 1;
    const reason = `release failed: ${error instanceof Error ? error.message : String(error)}`;
    outcome =
      attempts >= MAX_RELEASE_ATTEMPTS
        ? { state: "kept", reason: `${reason} (gave up after ${attempts} attempts)` }
        : { state: "failed", reason };
  }
  await setResourceState(db, row, outcome.state, outcome.reason, attempts);
  return Object.assign(row, outcome, { attempts });
}

/**
 * Apply one release decision to a run's live resources, and failed ones whose retry is due, and
 * return every record. Recorded-only kinds are not visited.
 */
export async function releaseRun(
  db: RegistrySql,
  factory: string,
  runId: string,
  action: ReleaseAction,
  outcome: RunOutcome,
): Promise<ResourceRecord[]> {
  const rows = await listResources(db, { factory, runId });
  const kept = { state: "kept" as const, reason: keepReason(outcome) };
  for (const row of releaseOrder(rows)) {
    if (releaseDue(row)) await releaseOne(db, row, rows, action === "keep" ? kept : undefined);
  }
  return rows.map(toRecord);
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
    releaseRun(locked, currentFactory(), runId, policy.onSuccess, "success"),
  );
  return { policy, resources };
}
