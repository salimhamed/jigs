// Run identity and the run listing behind `jigs ps`. Resolution lives here,
// server-side, because every route that names a run needs it — a CLI-side
// resolver would need its own index and a second round trip.

import { getHookByToken, getRun } from "workflow/api";
import { hydrateData, observabilityRevivers } from "workflow/observability";
import { getWorld } from "workflow/runtime";
import type { Factory } from "./factory";
import { type JobRunIds, listJobRunIds, runsWithActiveStep } from "./stalls";
import { TICKET_TOKEN_PREFIX, ticketToken } from "./suspension/tokens";
import { registrySql } from "./worktrees/sql";

// The SDK mints run ids as `wrun_` + a ULID, so a ref is run-id-shaped (with
// or without the prefix, full or truncated) or it is a ticket ref. Crockford
// base32 excludes I/L/O/U, and both ticket ref shapes we accept — AGE-317 and
// a UUID — carry a `-`, so the two branches can never claim the same string.
const RUN_ID_SHAPE = /^(?:wrun_)?([0-9A-HJKMNP-TV-Z]{1,26})$/i;
const RUN_ID_PREFIX = "wrun_";
const RUN_ID_LENGTH = RUN_ID_PREFIX.length + 26;

export const TERMINAL_RUN_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "cancelled",
]);

export type RunRef =
  | { kind: "found"; runId: string }
  | { kind: "unknown" }
  | { kind: "ambiguous"; candidates: string[] };

export interface RunLookupDeps {
  listRunIds?: () => Promise<string[]>;
  runExists?: (runId: string) => Promise<boolean>;
  hookRunId?: (token: string) => Promise<string | null>;
}

export async function resolveRunRef(
  ref: string,
  deps: RunLookupDeps = {},
): Promise<RunRef> {
  const shaped = RUN_ID_SHAPE.exec(ref);
  if (shaped?.[1] !== undefined) {
    const prefix = RUN_ID_PREFIX + shaped[1].toUpperCase();
    const runExists = deps.runExists ?? worldRunExists;
    if (prefix.length === RUN_ID_LENGTH && (await runExists(prefix))) {
      return { kind: "found", runId: prefix };
    }
    const listRunIds = deps.listRunIds ?? worldRunIds;
    const matches = (await listRunIds()).filter((id) => id.startsWith(prefix));
    const only = matches[0];
    if (matches.length === 1 && only !== undefined) {
      return { kind: "found", runId: only };
    }
    if (matches.length > 1) return { kind: "ambiguous", candidates: matches };
  }
  // The ticket claim is already the one-active-run-per-ticket index: it is
  // every run's first act, and the world deletes hooks at terminal state, so
  // the token resolves exactly the run that currently holds the ticket.
  const hookRunId = deps.hookRunId ?? worldHookRunId;
  const owner =
    (await hookRunId(ticketToken(ref))) ??
    (ref === ref.toUpperCase()
      ? null
      : await hookRunId(ticketToken(ref.toUpperCase())));
  return owner === null ? { kind: "unknown" } : { kind: "found", runId: owner };
}

export interface RunRow {
  runId: string;
  pipeline: string;
  status: string;
  trigger: string;
  createdAt: string;
}

export interface WorldRun {
  runId: string;
  workflowName: string;
  status: string;
  createdAt: Date;
  // Lifted out of the run's stored inputs by the listing below, so callers
  // (and their fakes) never handle the world's serialized form.
  triggerId?: string;
}

const SCHEDULE_TRIGGER_PREFIX = "schedule:";
const MANUAL_TRIGGER = "manual";

export const scheduleTriggerLabel = (name: string): string =>
  `${SCHEDULE_TRIGGER_PREFIX}${name}`;

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

// The ticket claim is held for the run's whole life, so it says nothing about
// being parked; every other hook is something the run waits on, including one
// carrying no jigs metadata to hydrate. `jigs ps` and `jigs cancel` must agree
// on this or a run ps calls suspended is one cancel refuses to confirm.
export const isParkToken = (token: string): boolean =>
  !token.startsWith(TICKET_TOKEN_PREFIX);

export interface StallDeps {
  jobRunIds?: () => Promise<JobRunIds>;
  runsWithActiveStep?: (runIds: string[]) => Promise<string[]>;
}

export interface RunListDeps extends StallDeps {
  listRuns?: () => Promise<WorldRun[]>;
  listHooks?: () => Promise<Array<{ runId: string; token: string }>>;
}

/**
 * The runs nothing is coming back for: the queue gave up on a job of theirs,
 * holds no live one to replace it, and no step is in flight. All three,
 * because a dead row is never cleared — a requeue and the World's own restart
 * reconciliation each add a job beside it, and a healed run would otherwise
 * read stalled in every gap between its steps.
 */
export async function stalledRuns(deps: StallDeps = {}): Promise<Set<string>> {
  const jobs = await (deps.jobRunIds ?? worldJobRunIds)();
  const live = new Set(jobs.live);
  const stranded = [...new Set(jobs.dead)].filter((id) => !live.has(id));
  if (stranded.length === 0) return new Set();
  const busy = new Set(
    await (deps.runsWithActiveStep ?? runsWithActiveStep)(stranded),
  );
  return new Set(stranded.filter((runId) => !busy.has(runId)));
}

/**
 * The one status derivation `jigs ps` and `jigs logs` both read. Suspended
 * first: a run parked on a hook is waiting on the world, not on a job nobody
 * is going to deliver.
 */
export function derivedRunStatus(
  status: string,
  run: { parked: boolean; stalled: boolean },
): string {
  if (TERMINAL_RUN_STATUSES.has(status)) return status;
  if (run.parked) return "suspended";
  return status === "running" && run.stalled ? "stalled" : status;
}

export async function listRuns(
  factory: Factory,
  deps: RunListDeps = {},
): Promise<RunRow[]> {
  const [runs, hooks, stalled] = await Promise.all([
    (deps.listRuns ?? worldRuns)(),
    (deps.listHooks ?? worldHooks)(),
    stalledRuns(deps),
  ]);
  const parkHooks = new Set(
    hooks.filter((hook) => isParkToken(hook.token)).map((hook) => hook.runId),
  );
  // The compiler stamps each pipeline with the workflowId the world stores as
  // workflowName; untransformed (unit tests, plain imports) there is nothing to
  // map and the raw name below is the honest answer.
  const pipelineByWorkflowId = new Map(
    Object.entries(factory.pipelines).flatMap(([name, entry]) => {
      const id = (entry.pipeline as { workflowId?: string }).workflowId;
      return id === undefined ? [] : [[id, name] as [string, string]];
    }),
  );
  return runs
    .map((run) => ({
      runId: run.runId,
      pipeline: pipelineByWorkflowId.get(run.workflowName) ?? run.workflowName,
      // The SDK has neither status: a non-terminal run holding a hook other
      // than its ticket claim is parked, and a run whose resume job died
      // reads `running` forever.
      status: derivedRunStatus(run.status, {
        parked: parkHooks.has(run.runId),
        stalled: stalled.has(run.runId),
      }),
      trigger: triggerLabel(run.triggerId),
      createdAt: run.createdAt.toISOString(),
    }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

const worldRunExists = (runId: string) => getRun(runId).exists;

const worldJobRunIds = (): Promise<JobRunIds> => listJobRunIds(registrySql());

const worldHookRunId = (token: string) =>
  getHookByToken(token).then(
    (hook) => hook.runId,
    () => null,
  );

// One page, deliberately: both the prefix scan and `jigs ps` are
// conveniences over a developer-scale run table, not indexes to page through.
// `resolveData: "all"` is what makes the trigger readable at all — a run's
// triggerId lives in its stored inputs and the world has no index on it. It
// costs nothing extra: world-postgres selects every column either way and
// only strips the data fields after the query.
async function worldRuns(): Promise<WorldRun[]> {
  const page = await getWorld().runs.list({
    resolveData: "all",
    pagination: { limit: 1000 },
  });
  return page.data.map((run) => {
    const triggerId = triggerIdOf(run.input);
    return { ...run, ...(triggerId === undefined ? {} : { triggerId }) };
  });
}

// Run inputs come back in the world's serialized form; the SDK's
// observability hydrator is the one public way to read them, and it leaves
// an encrypted payload as bytes rather than throwing. An input nobody can
// read costs the run its trigger, never the listing.
function triggerIdOf(input: unknown): string | undefined {
  let args: unknown;
  try {
    args = hydrateData(input, observabilityRevivers);
  } catch {
    return undefined;
  }
  const first = Array.isArray(args) ? args[0] : undefined;
  return typeof first === "object" &&
    first !== null &&
    "triggerId" in first &&
    typeof first.triggerId === "string"
    ? first.triggerId
    : undefined;
}

const worldRunIds = () => worldRuns().then((runs) => runs.map((r) => r.runId));

// Descending explicitly: the runs list is newest-first, hooks default to
// oldest-first, and two pages taken from opposite ends stop overlapping.
async function worldHooks(): Promise<Array<{ runId: string; token: string }>> {
  const page = await getWorld().hooks.list({
    pagination: { limit: 1000, sortOrder: "desc" },
  });
  return page.data.map((hook) => ({ runId: hook.runId, token: hook.token }));
}
