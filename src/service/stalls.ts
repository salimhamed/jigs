// The step half of stall diagnosis: what the World recorded and whether any
// operation is still in flight. Read-only queue evidence lives in queue.ts.

import { getWorld } from "workflow/runtime";

export interface StepView {
  name: string;
  status: string;
  attempt: number;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
}

const ACTIVE_STEP_STATUSES: ReadonlySet<string> = new Set(["running", "pending"]);

/** The steps a run recorded, oldest first. The World's own listing sorts by
 *  step id, which is only creation order while the ids are ULIDs. */
export async function listRunSteps(runId: string): Promise<StepView[]> {
  const world = await getWorld();
  const steps = [];
  let cursor: string | undefined;
  do {
    const page = await world.steps.list({
      runId,
      resolveData: "none",
      pagination: { limit: 1000, ...(cursor === undefined ? {} : { cursor }) },
    });
    steps.push(...page.data);
    cursor = page.hasMore && page.cursor !== null ? page.cursor : undefined;
  } while (cursor !== undefined);

  return steps
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    .map((step) => ({
      name: step.stepName,
      status: step.status,
      attempt: step.attempt,
      startedAt: iso(step.startedAt),
      completedAt: iso(step.completedAt),
      error: errorMessage(step.error),
    }));
}

/** The steps each of these runs recorded, so a caller that needs both the
 *  answer below and the steps themselves reads each run once. */
export async function listStepsByRun(runIds: readonly string[]): Promise<Map<string, StepView[]>> {
  const listed = await Promise.all(
    runIds.map(async (runId) => [runId, await listRunSteps(runId)] as const),
  );
  return new Map(listed);
}

export const hasActiveStep = (steps: readonly StepView[]): boolean =>
  steps.some((step) => ACTIVE_STEP_STATUSES.has(step.status));

/** Which of these runs still has a step in flight. */
export async function runsWithActiveStep(runIds: string[]): Promise<string[]> {
  const steps = await listStepsByRun(runIds);
  return runIds.filter((runId) => hasActiveStep(steps.get(runId) ?? []));
}

const iso = (at: Date | undefined) => at?.toISOString() ?? null;

function errorMessage(error: unknown): string | null {
  if (error instanceof Error) return error.message;
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }
  return null;
}
