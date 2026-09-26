import { TERMINAL_RUN_STATUSES } from "../../run-status.ts";
import { describeSuspension, type RunSuspension } from "../../run-suspension.ts";
import { TICKET_TOKEN_PREFIX } from "../../workflow/linear/claim.ts";
import type { ResourceRecord } from "../../workflow/runtime/resources.ts";
import { listResources, type RegistrySql, toRecord } from "./registry.ts";

/** A step as the World recorded it. */
export interface RunStepFact {
  name: string;
  status: string;
  startedAt: string | null;
  completedAt: string | null;
}

/**
 * What the World says about one run. The service reads it all; the offline CLI, which cannot
 * open the World, supplies the status alone.
 */
export interface RunFacts {
  /** The stored run, or null when the World has no such run. */
  run: {
    status: string;
    workflowName: string | null;
    trigger: string | null;
    ticket: string | null;
    createdAt: Date | null;
    updatedAt?: Date;
    completedAt?: Date;
  } | null;
  /** The hook tokens the run holds, read only while it is not finished. */
  tokens?: readonly string[];
  /** The run's steps, oldest first, where the caller read them. */
  steps?: readonly RunStepFact[];
}

export interface RunStep {
  name: string;
  status: string;
  at: string | null;
}

/** One run as plain data: the World's run, its hooks and its resources. */
export interface RunState {
  runId: string;
  /** The World's status, as the SDK reports it; null when the World has no such run. */
  status: string | null;
  /** The workflow ID the World stores, or null where it was not read. */
  workflowName: string | null;
  /** Which schedule launched the run, or `manual`. */
  trigger: string | null;
  /** The ticket the run was launched with, as the operator typed it. */
  ticket: string | null;
  createdAt: string | null;
  /** The last thing that happened to this run, step timings included. */
  lastActivityAt: string | null;
  /** How many steps the run recorded, or null where nothing read them. */
  steps: number | null;
  lastStep: RunStep | null;
  /**
   * What the run is parked on: a pull request watch, a needs-human halt, or another event. A
   * parked run's status stays `running`; a non-empty list is what says it is waiting.
   */
  suspensions: RunSuspension[];
  /** The ticket claim hook the run holds for its whole life, or null. */
  claim: string | null;
  /** Every resource the run recorded in this factory, released ones included. */
  resources: ResourceRecord[];
}

/** Whether nothing will come back for the run: terminal, or unknown to the World. */
export const finished = (state: Pick<RunState, "status">): boolean =>
  state.status === null || TERMINAL_RUN_STATUSES.has(state.status);

const iso = (at: Date | null | undefined): string | null => at?.toISOString() ?? null;

const latest = (times: Array<string | null>): string | null =>
  times.reduce<string | null>(
    (max, at) => (at !== null && (max === null || at > max) ? at : max),
    null,
  );

/** Describe one run from what the World said and the rows it recorded. */
export function describeRunState(
  runId: string,
  facts: RunFacts,
  resources: ResourceRecord[],
): RunState {
  const { run } = facts;
  const createdAt = iso(run?.createdAt);
  const steps = facts.steps;
  const last = steps?.at(-1);
  const stored: RunState = {
    runId,
    status: run?.status ?? null,
    workflowName: run?.workflowName ?? null,
    trigger: run?.trigger ?? null,
    ticket: run?.ticket ?? null,
    createdAt,
    lastActivityAt: iso(run?.completedAt) ?? iso(run?.updatedAt) ?? createdAt,
    steps: steps?.length ?? null,
    lastStep:
      last === undefined
        ? null
        : { name: last.name, status: last.status, at: last.completedAt ?? last.startedAt },
    suspensions: [],
    claim: null,
    resources,
  };
  // A finished run's ordinary hooks are already deleted.
  if (run === null || TERMINAL_RUN_STATUSES.has(run.status)) return stored;

  const tokens = facts.tokens ?? [];
  return {
    ...stored,
    lastActivityAt: latest([
      iso(run.updatedAt) ?? createdAt,
      ...(steps ?? []).flatMap((step) => [step.completedAt, step.startedAt]),
    ]),
    claim: tokens.find((token) => token.startsWith(TICKET_TOKEN_PREFIX)) ?? null,
    suspensions: tokens.flatMap((token) => describeSuspension(token, run.ticket) ?? []),
  };
}

/**
 * Read one run's whole state as plain data. `jigs status`, automatic release and prune all read
 * runs through this, and it is the snapshot later decisions are asked over.
 *
 * @example
 * ```ts
 * await readRunState(registrySql(), currentFactory(), runId, worldRunFacts);
 * // { runId: "wrun_01K…", status: "running", workflowName: "workflow//./workflows/ship//ship",
 * //   trigger: "manual", ticket: "<ticket>", …,
 * //   suspensions: [{ kind: "pull-request", reason: "waiting for pull request activity on acme/api#41", … }],
 * //   claim: "linear:ticket:…",
 * //   resources: [{ kind: "worktree", identity: "/…/worktrees/<branch>", state: "live", reason: null, … }] }
 * ```
 */
export async function readRunState(
  db: RegistrySql,
  factory: string,
  runId: string,
  readFacts: (runId: string) => Promise<RunFacts>,
): Promise<RunState> {
  const [rows, facts] = await Promise.all([
    listResources(db, { factory, runId }),
    readFacts(runId),
  ]);
  return describeRunState(runId, facts, rows.map(toRecord));
}
