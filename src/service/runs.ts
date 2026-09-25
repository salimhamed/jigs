// Run identity and the run listing behind `jigs status`. Resolution lives here,
// server-side, because every route that names a run needs it — a CLI-side
// resolver would need its own index and a second round trip.

import { getHookByToken, getRun } from "workflow/api";
import { hydrateData, observabilityRevivers } from "workflow/observability";
import { getWorld } from "workflow/runtime";
import type { PullRequestRef } from "../providers/github.ts";
import { getComment, resolveIssueRef } from "../providers/linear.ts";
import { TERMINAL_RUN_STATUSES } from "../run-status.ts";
import type { RunSuspension } from "../run-suspension.ts";
import { readPullRequestSnapshot } from "../steps/pull-requests/fetch-state.ts";
import { registrySql } from "../steps/workspaces/sql.ts";
import type { Factory } from "../workflow/factory.ts";
import { TICKET_TOKEN_PREFIX, ticketToken } from "../workflow/linear/claim.ts";
import { NEEDS_HUMAN_TOKEN_PREFIX } from "../workflow/linear/halt-for-human.ts";
import { mergeRefusal } from "../workflow/pull-requests/merge-ready.ts";
import { PULL_REQUEST_TOKEN_PREFIX } from "../workflow/pull-requests/pull-request.ts";
import { type CleanupView, cleanupFromAttributes } from "../workflow/runtime/cleanup.ts";
import { type RunResource, resourcesFromAttributes } from "../workflow/runtime/resources.ts";
import { type JobRunIds, listJobRunIds } from "./queue.ts";
import { hasActiveStep, listRunSteps, listStepsByRun, type StepView } from "./stalls.ts";
import { lastWake } from "./wake-note.ts";

// The SDK mints run ids as `wrun_` + a ULID, so a ref is run-id-shaped (with
// or without the prefix, full or truncated) or it is a ticket ref. Crockford
// base32 excludes I/L/O/U, and both ticket ref shapes we accept — AGE-123 and
// a UUID — carry a `-`, so the two branches can never claim the same string.
const RUN_ID_SHAPE = /^(?:wrun_)?([0-9A-HJKMNP-TV-Z]{1,26})$/i;
const RUN_ID_PREFIX = "wrun_";
const RUN_ID_LENGTH = RUN_ID_PREFIX.length + 26;

// A Linear identifier: team key then issue number. Only this shape is worth a
// Linear round trip — every other ticket ref is already the UUID the claim is
// keyed on, or is nothing Linear could place.
const TICKET_IDENTIFIER = /^[A-Za-z][A-Za-z0-9]*-\d+$/;

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
  // Stored launch inputs keep ticket selection useful after terminal cleanup
  // removes the ticket claim. Multiple executions for one ticket are
  // intentionally ambiguous: choosing the newest one would hide history.
  const runs = await worldRuns();
  const candidates = new Set(ticketRunIds(runs, ref));

  // Ticket claims are keyed by provider UUID. Resolve an identifier only
  // after reading stored inputs, then consider both historical UUID inputs
  // and the active claim owner before deciding whether the selector is unique.
  const issueId = TICKET_IDENTIFIER.test(ref) ? await linearIssueId(ref.toUpperCase()) : ref;
  if (issueId !== null) {
    for (const runId of ticketRunIds(runs, issueId)) candidates.add(runId);
    const owner = await worldHookRunId(ticketToken(issueId));
    if (owner !== null) candidates.add(owner);
  }
  const matches = [...candidates];
  if (matches.length === 1) return { kind: "found", runId: matches[0] as string };
  return matches.length > 1 ? { kind: "ambiguous", candidates: matches } : { kind: "unknown" };
}

const ticketRunIds = (runs: WorldRun[], ref: string): string[] => {
  const normalized = TICKET_IDENTIFIER.test(ref) ? ref.toUpperCase() : ref.toLowerCase();
  return runs
    .filter((run) => {
      const ticket = ticketOf(run.input);
      if (ticket === null) return false;
      return TICKET_IDENTIFIER.test(ref)
        ? ticket.toUpperCase() === normalized
        : ticket.toLowerCase() === normalized;
    })
    .map((run) => run.runId);
};

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
  attributes?: Record<string, string>;
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

export type { RunSuspension } from "../run-suspension.ts";

/**
 * What a run holding this hook is waiting for, or null when the hook is no
 * park at all. The token is the whole answer: it names what the run is waiting
 * on, so nothing has to be written down beside it. The ticket claim is held for
 * the run's whole life and so says nothing about waiting; every other hook is
 * something the run waits on, including a token jigs has never seen. `jigs status`,
 * `jigs watch` and `jigs cancel` all read this one function, or a run one calls
 * suspended is one another refuses to confirm.
 *
 * `ticket` is the identifier the run was launched with, so a halt names the
 * ticket an operator knows rather than the issue UUID inside the token.
 */
export function describeSuspension(token: string, ticket?: string | null): RunSuspension | null {
  if (token.startsWith(TICKET_TOKEN_PREFIX)) return null;
  const pr = prFromToken(token);
  if (pr !== null) {
    return {
      token,
      kind: "pull-request",
      reason: `waiting for pull request activity on ${pr.slug}`,
      url: pr.url,
    };
  }
  // The prefix alone decides the kind: a marker jigs minted is a halt even
  // when the rest of it is unreadable, and calling that external would point
  // an operator at the wrong thing to do about it.
  if (token.startsWith(NEEDS_HUMAN_TOKEN_PREFIX)) {
    const where = ticket ?? needsHumanParts(token)?.issueId;
    return {
      token,
      kind: "needs-human",
      reason:
        where === undefined
          ? `waiting for a human reply, on a ticket this halt marker does not name (${token})`
          : `waiting for a human reply on ${where}`,
    };
  }
  return { token, kind: "external", reason: `waiting for an external event (${token})` };
}

/** `github:pr:owner/repo#N` as the two things an operator needs from it. A
 *  slug this shape does not fit names no page to link to. */
function prFromToken(token: string): { slug: string; url?: string; pr?: PullRequestRef } | null {
  if (!token.startsWith(PULL_REQUEST_TOKEN_PREFIX)) return null;
  const slug = token.slice(PULL_REQUEST_TOKEN_PREFIX.length);
  const parsed = /^([^/]+)\/([^#]+)#(\d+)$/.exec(slug);
  if (parsed === null) return { slug };
  const [, owner, repo, number] = parsed;
  if (owner === undefined || repo === undefined || number === undefined) return { slug };
  return {
    slug,
    url: `https://github.com/${owner}/${repo}/pull/${number}`,
    pr: { owner, repo, number: Number(number) },
  };
}

/** `jigs:needs-human:<issue>:<comment>` — the halt marker, taken apart. */
function needsHumanParts(token: string): { issueId: string; commentId: string } | null {
  if (!token.startsWith(NEEDS_HUMAN_TOKEN_PREFIX)) return null;
  const [issueId, commentId] = token.slice(NEEDS_HUMAN_TOKEN_PREFIX.length).split(":");
  return issueId === undefined || commentId === undefined ? null : { issueId, commentId };
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

/** Which runs are stalled, and the steps that answer cost — the listing hands
 *  them straight back so no run is read twice in one request. */
interface StallReading {
  stalled: Set<string>;
  steps: Map<string, StepView[]>;
}

/**
 * The runs nothing is coming back for: the queue gave up on a job of theirs,
 * holds no live one to replace it, and no step is in flight. All three,
 * because a dead row is never cleared — a requeue and the World's own restart
 * reconciliation each add a job beside it, and a healed run would otherwise
 * read stalled in every gap between its steps.
 */
async function stalledRuns(): Promise<StallReading> {
  const jobs = await worldJobRunIds();
  const live = new Set(jobs.live);
  const stranded = [...new Set(jobs.dead)].filter((id) => !live.has(id));
  const steps = await listStepsByRun(stranded);
  return {
    stalled: new Set(stranded.filter((runId) => !hasActiveStep(steps.get(runId) ?? []))),
    steps,
  };
}

export interface RunStep {
  name: string;
  status: string;
  at: string | null;
}

export interface RunDescription {
  runId: string;
  status: string;
  trigger: string;
  /** The ticket the run was launched with, as the operator typed it. */
  ticket: string | null;
  createdAt: string;
  /** The last thing that happened to this run, step timings included. */
  lastActivityAt: string;
  /** How many steps the run recorded, or null where nothing read them. */
  steps: number | null;
  lastStep: RunStep | null;
  suspended: boolean;
  suspensions: RunSuspension[];
}

export interface RunRow extends RunDescription {
  workflow: string;
}

/** Facts a caller already holds. The listing has all of them for every run;
 *  a single run has none, and each is read here. */
export interface RunFacts {
  run?: WorldRun;
  tokens?: readonly string[];
  stalled?: boolean;
  steps?: readonly StepView[];
}

interface StepFacts {
  count: number;
  last: RunStep | null;
  latestAt: string | null;
}

/**
 * What this run is, past what the world stored: the SDK has neither
 * `suspended` nor `stalled`, so a run parked on a hook other than its ticket
 * claim reads `running` while it waits, and one whose resume job died reads
 * `running` forever. Both forms of `jigs status` ask this one function, or the
 * two verbs answer differently about the same run.
 *
 * Suspended wins over stalled: a parked run is waiting on the world, not on a
 * job nobody is going to deliver.
 */
export async function describeRun(runId: string, facts: RunFacts = {}): Promise<RunDescription> {
  const run = facts.run ?? (await worldRun(runId));
  const ticket = ticketOf(run.input);
  const createdAt = run.createdAt.toISOString();
  const stored: RunDescription = {
    runId,
    status: run.status,
    trigger: triggerLabel(run.triggerId),
    ticket,
    createdAt,
    lastActivityAt: iso(run.completedAt) ?? iso(run.updatedAt) ?? createdAt,
    steps: null,
    lastStep: null,
    suspended: false,
    suspensions: [],
  };
  // A terminal run's ordinary hooks are already deleted (minimum-retention
  // hooks are not part of jigs), and a dead job it left behind does not restate
  // its status, so neither is worth reading. Its steps are
  // history, and the listing does not pay to read them — it says null rather
  // than a count it never took. A caller holding them says how far the run got.
  if (TERMINAL_RUN_STATUSES.has(run.status)) {
    if (facts.steps === undefined) return stored;
    const { count, last } = stepFacts(facts.steps);
    return { ...stored, steps: count, lastStep: last };
  }

  const tokens = facts.tokens ?? (await worldRunTokens(runId));
  const steps = stepFacts(facts.steps ?? (await listRunSteps(runId)));
  const live: RunDescription = {
    ...stored,
    lastActivityAt: latest([iso(run.updatedAt) ?? createdAt, steps.latestAt]),
    steps: steps.count,
    lastStep: steps.last,
  };

  const suspensions = tokens.flatMap((token) => {
    const suspension = describeSuspension(token, ticket);
    return suspension === null ? [] : [suspension];
  });
  if (suspensions.length > 0) return { ...live, status: "suspended", suspended: true, suspensions };

  // Only a running run can be stalled — nothing has been handed to the queue
  // for a pending one — and asking costs a queue read.
  if (run.status !== "running") return live;
  const stalled = facts.stalled ?? (await stalledRuns()).stalled.has(runId);
  return stalled ? { ...live, status: "stalled" } : live;
}

export async function listRuns(factory: Factory): Promise<RunRow[]> {
  const [runs, hooks, stranded] = await Promise.all([worldRuns(), listWorldHooks(), stalledRuns()]);
  const tokensByRun = Map.groupBy(hooks, (hook) => hook.runId);
  // The compiler stamps each workflow with the workflowId the world stores as
  // workflowName; untransformed (unit tests, plain imports) there is nothing to
  // map and the raw name below is the honest answer.
  const workflowByWorkflowId = new Map(
    Object.entries(factory.workflows).flatMap(([name, entry]) => {
      const id = (entry.workflow as { workflowId?: string }).workflowId;
      return id === undefined ? [] : [[id, name] as [string, string]];
    }),
  );
  // Only the runs still in play are read step by step; a finished one has
  // nothing left to happen to it.
  const rows = await Promise.all(
    runs.map(async (run) => {
      const described = await describeRun(run.runId, {
        run,
        tokens: (tokensByRun.get(run.runId) ?? []).map((hook) => hook.token),
        stalled: stranded.stalled.has(run.runId),
        // The stall check already listed these; reading them again would ask
        // the world for the same page twice in one request.
        steps: stranded.steps.get(run.runId),
      });
      return {
        ...described,
        workflow: workflowByWorkflowId.get(run.workflowName) ?? run.workflowName,
      };
    }),
  );
  return rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** How far this run has got, and when it last moved. */
function stepFacts(steps: readonly StepView[]): StepFacts {
  const last = steps.at(-1);
  const times = steps.flatMap((step) => [step.completedAt, step.startedAt].filter(isIso));
  return {
    count: steps.length,
    last: last === undefined ? null : { name: last.name, status: last.status, at: stepAt(last) },
    latestAt: times.length === 0 ? null : latest(times),
  };
}

const isIso = (value: string | null): value is string => value !== null;

const stepAt = (step: StepView): string | null => step.completedAt ?? step.startedAt;

const latest = (times: Array<string | null>): string =>
  times.filter(isIso).reduce((max, at) => (at > max ? at : max), "");

const iso = (at: Date | undefined): string | null => at?.toISOString() ?? null;

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

/** Resources are an observability read, independent of workflow output. */
export async function listRunResources(runId: string): Promise<RunResource[]> {
  return resourcesFromAttributes((await worldRun(runId)).attributes);
}

/** Persistent automatic-cleanup progress, independent of workflow output. */
export async function readRunCleanup(runId: string): Promise<CleanupView> {
  return cleanupFromAttributes((await worldRun(runId)).attributes);
}

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

const worldRunIds = () => worldRuns().then((runs) => runs.map((r) => r.runId));

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
