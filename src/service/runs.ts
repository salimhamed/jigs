// Run identity and the run listing behind `jigs status`.

import { getRun } from "workflow/api";
import { WorkflowRunNotFoundError } from "workflow/errors";
import { hydrateData, observabilityRevivers } from "workflow/observability";
import { getWorld } from "workflow/runtime";
import type { PullRequestRef } from "../providers/github.ts";
import { getComment } from "../providers/linear.ts";
import { TERMINAL_RUN_STATUSES } from "../run-status.ts";
import { needsHumanParts, prFromToken, type RunSuspension } from "../run-suspension.ts";
import { readPullRequestSnapshot } from "../steps/pull-requests/fetch-state.ts";
import { currentFactory, listResources, registrySql, toRecord } from "../steps/runtime/registry.ts";
import { describeRunState, type RunFacts, type RunState } from "../steps/runtime/run-state.ts";
import type { Factory } from "../workflow/factory.ts";
import { mergeRefusal } from "../workflow/pull-requests/merge-ready.ts";
import { lastWake } from "./wake-note.ts";

// The SDK mints run IDs as `wrun_` + a ULID. Anything else names no run, and
// never reaches the World as a lookup key.
const RUN_ID_SHAPE = /^wrun_[0-9A-HJKMNP-TV-Z]{26}$/;

/** Whether a run with exactly this ID exists; commands name runs by full ID only. */
export const runExists = async (runId: string): Promise<boolean> =>
  RUN_ID_SHAPE.test(runId) && (await getRun(runId).exists);

export interface WorldRun {
  runId: string;
  workflowName: string;
  status: string;
  createdAt: Date;
  updatedAt?: Date;
  completedAt?: Date;
  /** The run's own arguments and return value, in the world's serialized form. */
  input?: unknown;
  output?: unknown;
  // Lifted out of the run's stored inputs by the listing below, so callers
  // (and their fakes) never handle the world's serialized form.
  triggerId?: string;
}

const SCHEDULE_TRIGGER_PREFIX = "schedule:";
const MANUAL_TRIGGER = "manual";

export const scheduleTriggerLabel = (name: string): string => `${SCHEDULE_TRIGGER_PREFIX}${name}`;

/** What a scheduled fire records as its triggerId: the schedule that fired
 *  it and the tick it fired on. */
export function scheduleTriggerId(name: string, at: Date): string {
  return `${scheduleTriggerLabel(name)}:${at.toISOString().slice(0, 19)}Z`;
}

/** The `trigger` column: which schedule launched a run, or `manual`. A
 *  triggerId nothing can read — an encrypted World's inputs — reads as
 *  manual too, because that is what every other launch is. */
export function triggerLabel(triggerId: string | undefined): string {
  if (triggerId === undefined || !triggerId.startsWith(SCHEDULE_TRIGGER_PREFIX))
    return MANUAL_TRIGGER;
  const rest = triggerId.slice(SCHEDULE_TRIGGER_PREFIX.length);
  const end = rest.indexOf(":");
  return scheduleTriggerLabel(end === -1 ? rest : rest.slice(0, end));
}

/**
 * What the providers say about one run's suspensions: the pull request the
 * run is watching, and the comment a halt is waiting on. Failures leave
 * a suspension exactly as its token described it — observability must never
 * break the route — so this is for the single-run read only, never the listing.
 */
export async function enrichSuspensions(
  suspensions: readonly RunSuspension[],
  runId: string,
): Promise<RunSuspension[]> {
  return await Promise.all(
    suspensions.map(async (suspension) => {
      const pr = prFromToken(suspension.token)?.pr;
      if (pr !== undefined) return await withPrState(suspension, pr, runId);
      const halt = needsHumanParts(suspension.token);
      if (halt === null) return suspension;
      const comment = await getComment(halt.commentId).catch(() => null);
      if (comment === null) return suspension;
      return { ...suspension, url: comment.url, question: comment.body };
    }),
  );
}

/**
 * The pull request as the merge step sees it: the same refusal the step merges
 * on, so what an operator reads here and what jigs is doing cannot disagree. `blocker` is why it will not merge, in the words of the refusal.
 */
async function withPrState(
  suspension: RunSuspension,
  pr: PullRequestRef,
  runId: string,
): Promise<RunSuspension> {
  const wake = lastWake(suspension.token, runId);
  const withWake = wake === undefined ? suspension : { ...suspension, lastWake: wake };
  try {
    const snapshot = await readPullRequestSnapshot(pr);
    return {
      ...withWake,
      headSha: snapshot.headSha.slice(0, 7),
      ci: snapshot.ci,
      approval: snapshot.approval.state,
      draft: snapshot.draft,
      mergeState: snapshot.mergeState,
      blocker: mergeRefusal(snapshot, snapshot.headSha)?.reason ?? "nothing — it can merge",
    };
  } catch {
    return withWake;
  }
}

export interface RunRow extends RunState {
  workflow: string;
}

const runFacts = (run: WorldRun): NonNullable<RunFacts["run"]> => ({
  status: run.status,
  workflowName: run.workflowName,
  trigger: triggerLabel(run.triggerId),
  ticket: ticketOf(run.input),
  createdAt: run.createdAt,
  ...(run.updatedAt === undefined ? {} : { updatedAt: run.updatedAt }),
  ...(run.completedAt === undefined ? {} : { completedAt: run.completedAt }),
});

/**
 * What the World says about one run, for `readRunState`. A live run's hooks and steps are
 * read; `detail` also reads a finished run's steps, which only the single-run route pays for.
 */
export async function worldRunFacts(runId: string, detail = false): Promise<RunFacts> {
  let run: WorldRun;
  try {
    run = await worldRun(runId);
  } catch (error) {
    if (WorkflowRunNotFoundError.is(error)) return { run: null };
    throw error;
  }
  if (TERMINAL_RUN_STATUSES.has(run.status)) {
    return detail
      ? { run: runFacts(run), steps: await listRunSteps(runId) }
      : { run: runFacts(run) };
  }
  const [tokens, steps] = await Promise.all([worldRunTokens(runId), listRunSteps(runId)]);
  return { run: runFacts(run), tokens, steps };
}

/** Every run this factory's World holds, described the way `readRunState` describes one. */
export async function listRuns(factory: Factory): Promise<RunRow[]> {
  const [runs, hooks] = await Promise.all([worldRuns(), listWorldHooks()]);
  const rows = await listResources(registrySql(), {
    factory: currentFactory(),
    runIds: runs.map((run) => run.runId),
  });
  const tokensByRun = Map.groupBy(hooks, (hook) => hook.runId);
  const rowsByRun = Map.groupBy(rows, (row) => row.runId);
  // The compiler stamps each workflow with the workflowId the world stores as
  // workflowName; untransformed (unit tests, plain imports) there is nothing to
  // map and the raw name below is the honest answer.
  const workflowByWorkflowId = new Map(
    Object.entries(factory.workflows).flatMap(([name, entry]) => {
      const id = (entry.workflow as { workflowId?: string }).workflowId;
      return id === undefined ? [] : [[id, name] as [string, string]];
    }),
  );
  // A finished run's steps are history the listing does not pay to read.
  const described = await Promise.all(
    runs.map(async (run) => ({
      ...describeRunState(
        run.runId,
        {
          run: runFacts(run),
          tokens: (tokensByRun.get(run.runId) ?? []).map((hook) => hook.token),
          ...(TERMINAL_RUN_STATUSES.has(run.status)
            ? {}
            : { steps: await listRunSteps(run.runId) }),
        },
        (rowsByRun.get(run.runId) ?? []).map(toRecord),
      ),
      workflow: workflowByWorkflowId.get(run.workflowName) ?? run.workflowName,
    })),
  );
  return described.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
}

async function worldRuns(): Promise<WorldRun[]> {
  const runs: WorldRun[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await (await getWorld()).runs.list({
      resolveData: "all",
      pagination: { limit: 1000, ...(cursor === undefined ? {} : { cursor }) },
    });
    runs.push(...page.data.map(withTriggerId));
    cursor = nextCursor(page, seen, "runs");
  } while (cursor !== undefined);
  return runs;
}

const worldRun = async (runId: string): Promise<WorldRun> =>
  withTriggerId(await (await getWorld()).runs.get(runId, { resolveData: "all" }));

// `resolveData: "all"` above is what makes the trigger readable at all — a
// run's triggerId lives in its stored inputs and the world has no index on
// it. It costs nothing extra: world-postgres selects every column either way
// and only strips the data fields after the query.
function withTriggerId(run: WorldRun): WorldRun {
  const triggerId = triggerIdOf(run.input);
  return { ...run, ...(triggerId === undefined ? {} : { triggerId }) };
}

async function worldRunTokens(runId: string): Promise<string[]> {
  const page = await (await getWorld()).hooks.list({ runId });
  return page.data.map((hook) => hook.token);
}

// Run inputs and results come back in the world's serialized form; the SDK's
// observability hydrator is the one public way to read them, and it leaves an
// encrypted payload as bytes rather than throwing. Data nobody can read costs
// the run its trigger and its ticket, but never the listing.

function hydrate(data: unknown): unknown {
  // Nothing stored is nothing to read, not a payload that could not be read.
  if (data === undefined) return undefined;
  try {
    return hydrateData(data, observabilityRevivers);
  } catch {
    return undefined;
  }
}

/** The one object a workflow is launched with: its inputs and the trigger. */
function launchInputs(input: unknown): Record<string, unknown> | undefined {
  const args = hydrate(input);
  const first = Array.isArray(args) ? args[0] : undefined;
  return typeof first === "object" && first !== null
    ? (first as Record<string, unknown>)
    : undefined;
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" ? value : undefined;
}

const triggerIdOf = (input: unknown): string | undefined =>
  stringField(launchInputs(input), "triggerId");

const ticketOf = (input: unknown): string | null =>
  stringField(launchInputs(input), "ticket") ?? null;

/** Every hook the world holds, whichever run owns it. */
export async function listWorldHooks(): Promise<Array<{ runId: string; token: string }>> {
  const hooks: Array<{ runId: string; token: string }> = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await (await getWorld()).hooks.list({
      pagination: {
        limit: 1000,
        sortOrder: "desc",
        ...(cursor === undefined ? {} : { cursor }),
      },
    });
    hooks.push(...page.data.map((hook) => ({ runId: hook.runId, token: hook.token })));
    cursor = nextCursor(page, seen, "hooks");
  } while (cursor !== undefined);
  return hooks;
}

function nextCursor(
  page: { hasMore?: boolean; cursor?: string | null },
  seen: Set<string>,
  resource: string,
): string | undefined {
  if (page.hasMore !== true) return undefined;
  if (page.cursor === undefined || page.cursor === null || page.cursor === "") {
    throw new Error(`${resource} pagination says more data exists but returned no cursor`);
  }
  if (seen.has(page.cursor)) throw new Error(`${resource} pagination repeated its cursor`);
  seen.add(page.cursor);
  return page.cursor;
}

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
    if (page.hasMore) {
      if (page.cursor == null) {
        throw new Error("World returned hasMore=true without a continuation cursor");
      }
      cursor = page.cursor;
    } else {
      cursor = undefined;
    }
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

/** Which of these runs still has a step in flight. */
export async function runsWithActiveStep(runIds: string[]): Promise<string[]> {
  const active = await Promise.all(
    runIds.map(async (runId) =>
      (await listRunSteps(runId)).some((step) => ACTIVE_STEP_STATUSES.has(step.status)),
    ),
  );
  return runIds.filter((_, index) => active[index]);
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
