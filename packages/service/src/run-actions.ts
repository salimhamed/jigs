// What can be asked of one run: read it, wake it, cancel it. Lifted out of
// the HTTP handlers because the Slack agent's tools answer the same questions
// in-process — an operator asking in a thread and an operator typing `jigs
// logs` must read the same run, and a second implementation is how they stop.

import { getHookByToken, getRun, resumeHook } from "workflow/api";
import { getWorld } from "workflow/runtime";
import type { WakeHint } from "./ingress";
import {
  derivedRunStatus,
  isParkToken,
  stalledRuns,
  TERMINAL_RUN_STATUSES,
} from "./runs";
import {
  type DeadJobView,
  listRunDeadJobs,
  listRunSteps,
  type StepView,
} from "./stalls";
import {
  readSuspensionMetadata,
  type SuspensionRecord,
} from "./suspension/record";
import { listWorktreesForRun } from "./worktrees/registry";
import { registrySql } from "./worktrees/sql";

export interface RunDetail {
  runId: string;
  status: string;
  logs: string;
  returnValue?: unknown;
  error?: string;
  suspended?: boolean;
  suspensions?: SuspensionRecord[];
}

export interface RunTimeline {
  steps: StepView[];
  deadJobs: DeadJobView[];
}

export type PokeResult =
  | {
      kind: "poked";
      runId: string;
      poked: Array<{ token: string; resumed: boolean }>;
    }
  | { kind: "no-suspensions" };

export type CancelResult =
  | {
      kind: "cancelled";
      runId: string;
      releasedTokens: string[];
      worktrees: string[];
    }
  | { kind: "already-terminal"; status: string };

/**
 * The run's page on the dashboard this service hosts. A service started
 * without a dashboard port has none to point at, and the answer is not to name
 * a standalone `workflow web`: run against a live World it opens a second
 * queue worker and steals the jobs this run is waiting on.
 */
export const DASHBOARD_NOT_CONFIGURED = "dashboard: not configured";

export function logsPointer(runId: string): string {
  const port = process.env.JIGS_DASHBOARD_PORT;
  return port === undefined || port === ""
    ? DASHBOARD_NOT_CONFIGURED
    : `http://localhost:${port}/run/${runId}`;
}

// Raw tokens alongside the hydrated records: parkedness is a property of the
// token, but only a record can say why, and both come from the one listing.
export async function listSuspensions(
  runId: string,
): Promise<{ tokens: string[]; records: SuspensionRecord[] }> {
  const hooks = await getWorld().hooks.list({ runId });
  // The world's list returns metadata still serialized (binary devalue);
  // only getHookByToken hydrates it — hence the per-hook round trip. The
  // rejection handler absorbs a hook disposed between list and get.
  const hydrated = await Promise.all(
    hooks.data.map((hook) =>
      getHookByToken(hook.token).then(
        (full) => readSuspensionMetadata(full.metadata),
        () => null,
      ),
    ),
  );
  return {
    tokens: hooks.data.map((hook) => hook.token),
    records: hydrated.filter(
      (record): record is SuspensionRecord => record !== null,
    ),
  };
}

export async function runDetail(runId: string): Promise<RunDetail> {
  const run = getRun(runId);
  const status = await run.status;
  const detail: RunDetail = {
    runId: run.runId,
    status,
    logs: logsPointer(run.runId),
  };
  if (status === "completed") detail.returnValue = await run.returnValue;
  if (status === "failed") {
    detail.error = await run.returnValue.then(
      () => undefined,
      (err: unknown) => String(err),
    );
  }
  // The SDK has neither `suspended` nor `stalled`, so jigs derives both —
  // through the same function `jigs ps` reads, or the two verbs disagree
  // about the same run. A hook carrying no jigs metadata still parks the
  // run; it just has no record to explain itself with, which is why
  // `suspended` and `suspensions` are separate answers.
  if (status === "running") {
    const { tokens, records } = await listSuspensions(run.runId);
    const parked = tokens.some(isParkToken);
    detail.suspensions = records;
    detail.suspended = parked;
    detail.status = derivedRunStatus(status, {
      parked,
      stalled: !parked && (await stalledRuns()).has(run.runId),
    });
  }
  return detail;
}

export async function runTimeline(runId: string): Promise<RunTimeline> {
  const sql = registrySql();
  const [steps, deadJobs] = await Promise.all([
    listRunSteps(runId),
    sql === null ? [] : listRunDeadJobs(sql, runId),
  ]);
  return { steps, deadJobs };
}

/** Resume every token this run's suspensions are satisfied by — the fallback
 *  when a webhook delivery was missed. */
export async function pokeRun(runId: string): Promise<PokeResult> {
  const { records } = await listSuspensions(runId);
  const tokens = [...new Set(records.map((s) => s.satisfiedBy))];
  if (tokens.length === 0) return { kind: "no-suspensions" };
  const poked = await Promise.all(
    tokens.map((token) =>
      resumeHook(token, { source: "poke" } satisfies WakeHint).then(
        () => ({ token, resumed: true }),
        // A hook disposed between list and resume is a report, not an error.
        () => ({ token, resumed: false }),
      ),
    ),
  );
  return { kind: "poked", runId, poked };
}

/**
 * The escape hatch for a zombie claim owner. Cancelling releases every hook
 * the run holds — the world deletes them on run_cancelled — so the tokens are
 * captured before the cancel, not after.
 */
export async function cancelRun(runId: string): Promise<CancelResult> {
  const run = getRun(runId);
  const status = await run.status;
  if (TERMINAL_RUN_STATUSES.has(status)) {
    return { kind: "already-terminal", status };
  }
  const { records } = await listSuspensions(runId);
  const releasedTokens = [...new Set(records.map((s) => s.satisfiedBy))];
  await run.cancel();
  // Cancel never cleans up: name what stays so the operator knows where the
  // worktree is and that `jigs sweep` is the way to reclaim it. A merged run's
  // pipeline tears its own worktree down; everything else — cancel included —
  // leaves the tree on disk, which is exactly the wreckage the sweep exists to
  // surface.
  const sql = registrySql();
  const worktrees =
    sql === null
      ? []
      : (await listWorktreesForRun(sql, runId)).map((row) => row.path);
  return { kind: "cancelled", runId, releasedTokens, worktrees };
}
