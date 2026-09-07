// Run identity and the run listing behind `jigs ps`. Resolution lives here,
// server-side, because every route that names a run needs it — a CLI-side
// resolver would need its own index and a second round trip.

import { getHookByToken, getRun } from "workflow/api";
import { hydrateData, observabilityRevivers } from "workflow/observability";
import { getWorld } from "workflow/runtime";
import type { Factory } from "./factory.ts";
import { resolveIssueRef } from "./providers/linear.ts";
import { type JobRunIds, listJobRunIds, runsWithActiveStep } from "./stalls.ts";
import { TICKET_TOKEN_PREFIX, ticketToken } from "./suspension/claim.ts";
import { NEEDS_HUMAN_TOKEN_PREFIX } from "./suspension/needs-human.ts";
import { PR_TOKEN_PREFIX } from "./suspension/pull-request-gate.ts";
import { registrySql } from "./worktrees/sql.ts";

// The SDK mints run ids as `wrun_` + a ULID, so a ref is run-id-shaped (with
// or without the prefix, full or truncated) or it is a ticket ref. Crockford
// base32 excludes I/L/O/U, and both ticket ref shapes we accept — AGE-317 and
// a UUID — carry a `-`, so the two branches can never claim the same string.
const RUN_ID_SHAPE = /^(?:wrun_)?([0-9A-HJKMNP-TV-Z]{1,26})$/i;
const RUN_ID_PREFIX = "wrun_";
const RUN_ID_LENGTH = RUN_ID_PREFIX.length + 26;

// A Linear identifier: team key then issue number. Only this shape is worth a
// Linear round trip — every other ticket ref is already the UUID the claim is
// keyed on, or is nothing Linear could place.
const TICKET_IDENTIFIER = /^[A-Za-z][A-Za-z0-9]*-\d+$/;

export const TERMINAL_RUN_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "cancelled",
]);

export type RunRef =
  | { kind: "found"; runId: string }
  | { kind: "unknown" }
  | { kind: "ambiguous"; candidates: string[] };

export async function resolveRunRef(ref: string): Promise<RunRef> {
  const shaped = RUN_ID_SHAPE.exec(ref);
  if (shaped?.[1] !== undefined) {
    const prefix = RUN_ID_PREFIX + shaped[1].toUpperCase();
    if (prefix.length === RUN_ID_LENGTH && (await worldRunExists(prefix))) {
      return { kind: "found", runId: prefix };
    }
    const matches = (await worldRunIds()).filter((id) => id.startsWith(prefix));
    const only = matches[0];
    if (matches.length === 1 && only !== undefined) {
      return { kind: "found", runId: only };
    }
    if (matches.length > 1) return { kind: "ambiguous", candidates: matches };
  }
  // The ticket claim is already the one-active-run-per-ticket index: it is
  // every run's first act, and the world deletes hooks at terminal state, so
  // the token resolves exactly the run that currently holds the ticket. It is
  // keyed on the issue's UUID, so an identifier first costs the same Linear
  // lookup the trigger already makes to start a run — upper-cased, because
  // Linear keys identifiers by upper-case team key.
  const issueId = TICKET_IDENTIFIER.test(ref)
    ? await linearIssueId(ref.toUpperCase())
    : ref;
  if (issueId === null) return { kind: "unknown" };
  const owner = await worldHookRunId(ticketToken(issueId));
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

/**
 * Why a run holding this hook is parked, or null when the hook is no park at
 * all. The token is the whole answer: it names what the run is waiting on, so
 * nothing has to be written down beside it. The ticket claim is held for the
 * run's whole life and so says nothing about waiting; every other hook is
 * something the run waits on, including a token jigs has never seen. `jigs ps`,
 * `jigs logs` and `jigs cancel` all read this one function, or a run one calls
 * suspended is one another refuses to confirm.
 */
export function parkReason(token: string): string | null {
  if (token.startsWith(TICKET_TOKEN_PREFIX)) return null;
  if (token.startsWith(PR_TOKEN_PREFIX)) return "awaiting pull request review";
  if (token.startsWith(NEEDS_HUMAN_TOKEN_PREFIX))
    return "needs a human on the ticket";
  return "awaiting an external event";
}

/**
 * The runs nothing is coming back for: the queue gave up on a job of theirs,
 * holds no live one to replace it, and no step is in flight. All three,
 * because a dead row is never cleared — a requeue and the World's own restart
 * reconciliation each add a job beside it, and a healed run would otherwise
 * read stalled in every gap between its steps.
 */
async function stalledRuns(): Promise<Set<string>> {
  const jobs = await worldJobRunIds();
  const live = new Set(jobs.live);
  const stranded = [...new Set(jobs.dead)].filter((id) => !live.has(id));
  if (stranded.length === 0) return new Set();
  const busy = new Set(await runsWithActiveStep(stranded));
  return new Set(stranded.filter((runId) => !busy.has(runId)));
}

export interface RunSuspension {
  token: string;
  reason: string;
}

export interface RunDescription {
  runId: string;
  status: string;
  trigger: string;
  suspended: boolean;
  suspensions: RunSuspension[];
}

/** Facts a caller already holds. The listing has all of them for every run;
 *  a single run has none, and each is read here. */
export interface RunFacts {
  run?: WorldRun;
  tokens?: readonly string[];
  stalled?: boolean;
}

/**
 * What this run is, past what the world stored: the SDK has neither
 * `suspended` nor `stalled`, so a run parked on a hook other than its ticket
 * claim reads `running` while it waits, and one whose resume job died reads
 * `running` forever. `jigs ps` and `jigs logs` ask this one function, or the
 * two verbs answer differently about the same run.
 *
 * Suspended wins over stalled: a parked run is waiting on the world, not on a
 * job nobody is going to deliver.
 */
export async function describeRun(
  runId: string,
  facts: RunFacts = {},
): Promise<RunDescription> {
  const run = facts.run ?? (await worldRun(runId));
  const stored: RunDescription = {
    runId,
    status: run.status,
    trigger: triggerLabel(run.triggerId),
    suspended: false,
    suspensions: [],
  };
  // A terminal run's hooks are already deleted, and a dead job it left behind
  // does not restate its status, so neither is worth reading.
  if (TERMINAL_RUN_STATUSES.has(run.status)) return stored;

  const suspensions = (facts.tokens ?? (await worldRunTokens(runId))).flatMap(
    (token) => {
      const reason = parkReason(token);
      return reason === null ? [] : [{ token, reason }];
    },
  );
  if (suspensions.length > 0)
    return { ...stored, status: "suspended", suspended: true, suspensions };

  // Only a running run can be stalled — nothing has been handed to the queue
  // for a pending one — and asking costs a queue read.
  if (run.status !== "running") return stored;
  const stalled = facts.stalled ?? (await stalledRuns()).has(runId);
  return stalled ? { ...stored, status: "stalled" } : stored;
}

export async function listRuns(factory: Factory): Promise<RunRow[]> {
  const [runs, hooks, stalled] = await Promise.all([
    worldRuns(),
    worldHooks(),
    stalledRuns(),
  ]);
  const tokensByRun = Map.groupBy(hooks, (hook) => hook.runId);
  // The compiler stamps each pipeline with the workflowId the world stores as
  // workflowName; untransformed (unit tests, plain imports) there is nothing to
  // map and the raw name below is the honest answer.
  const pipelineByWorkflowId = new Map(
    Object.entries(factory.pipelines).flatMap(([name, entry]) => {
      const id = (entry.pipeline as { workflowId?: string }).workflowId;
      return id === undefined ? [] : [[id, name] as [string, string]];
    }),
  );
  // Every fact is already in hand, so no description reaches back to the world.
  const rows = await Promise.all(
    runs.map(async (run) => {
      const described = await describeRun(run.runId, {
        run,
        tokens: (tokensByRun.get(run.runId) ?? []).map((hook) => hook.token),
        stalled: stalled.has(run.runId),
      });
      return {
        runId: run.runId,
        pipeline:
          pipelineByWorkflowId.get(run.workflowName) ?? run.workflowName,
        status: described.status,
        trigger: described.trigger,
        createdAt: run.createdAt.toISOString(),
      };
    }),
  );
  return rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

const worldRunExists = (runId: string) => getRun(runId).exists;

const worldJobRunIds = (): Promise<JobRunIds> => listJobRunIds(registrySql());

const worldHookRunId = (token: string) =>
  getHookByToken(token).then(
    (hook) => hook.runId,
    () => null,
  );

// A ref Linear cannot place — or cannot be asked about, with no API key
// configured — is a ref no run holds, which is the answer either way.
const linearIssueId = (ref: string) =>
  resolveIssueRef(ref).then(
    (issue) => issue.id,
    () => null,
  );

// One page, deliberately: both the prefix scan and `jigs ps` are
// conveniences over a developer-scale run table, not indexes to page through.
async function worldRuns(): Promise<WorldRun[]> {
  const page = await getWorld().runs.list({
    resolveData: "all",
    pagination: { limit: 1000 },
  });
  return page.data.map(withTriggerId);
}

const worldRun = async (runId: string): Promise<WorldRun> =>
  withTriggerId(await getWorld().runs.get(runId, { resolveData: "all" }));

// `resolveData: "all"` above is what makes the trigger readable at all — a
// run's triggerId lives in its stored inputs and the world has no index on
// it. It costs nothing extra: world-postgres selects every column either way
// and only strips the data fields after the query.
function withTriggerId(run: WorldRun & { input?: unknown }): WorldRun {
  const triggerId = triggerIdOf(run.input);
  return { ...run, ...(triggerId === undefined ? {} : { triggerId }) };
}

async function worldRunTokens(runId: string): Promise<string[]> {
  const page = await getWorld().hooks.list({ runId });
  return page.data.map((hook) => hook.token);
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
