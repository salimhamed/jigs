// Run identity and the run listing behind `jigs ps`. Resolution lives here,
// server-side, because every route that names a run needs it — a CLI-side
// resolver would need its own index and a second round trip.

import { getHookByToken, getRun } from "workflow/api";
import { getWorld } from "workflow/runtime";
import { registry } from "./registry";
import { ticketToken } from "./suspension/tokens";

// The SDK mints run ids as `wrun_` + a ULID, so a ref is run-id-shaped (with
// or without the prefix, full or truncated) or it is a ticket ref. Crockford
// base32 excludes I/L/O/U, and both ticket ref shapes we accept — AGE-317 and
// a UUID — carry a `-`, so the two branches can never claim the same string.
const RUN_ID_SHAPE = /^(?:wrun_)?([0-9A-HJKMNP-TV-Z]{1,26})$/i;
const RUN_ID_PREFIX = "wrun_";
const RUN_ID_LENGTH = RUN_ID_PREFIX.length + 26;

const TERMINAL_RUN_STATUSES: ReadonlySet<string> = new Set([
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
  const owner = await hookRunId(ticketToken(ref));
  return owner === null ? { kind: "unknown" } : { kind: "found", runId: owner };
}

export interface RunRow {
  runId: string;
  pipeline: string;
  status: string;
  createdAt: string;
}

export interface WorldRun {
  runId: string;
  workflowName: string;
  status: string;
  createdAt: Date;
}

export interface RunListDeps {
  listRuns?: () => Promise<WorldRun[]>;
  listHookRunIds?: () => Promise<string[]>;
}

export async function listRuns(deps: RunListDeps = {}): Promise<RunRow[]> {
  const [runs, hookRunIds] = await Promise.all([
    (deps.listRuns ?? worldRuns)(),
    (deps.listHookRunIds ?? worldHookRunIds)(),
  ]);
  const holdingHooks = new Set(hookRunIds);
  return runs
    .map((run) => ({
      runId: run.runId,
      pipeline: pipelineName(run.workflowName),
      // Same reasoning as GET /api/runs/:runId: the SDK has no `suspended`
      // status, so a non-terminal run still holding a hook is parked.
      status:
        !TERMINAL_RUN_STATUSES.has(run.status) && holdingHooks.has(run.runId)
          ? "suspended"
          : run.status,
      createdAt: run.createdAt.toISOString(),
    }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

// The compiler stamps each pipeline with the workflowId the world stores as
// workflowName; untransformed (unit tests, plain imports) there is nothing to
// map and the raw name is the honest answer.
let pipelineByWorkflowId: Map<string, string> | null = null;

function pipelineName(workflowName: string): string {
  pipelineByWorkflowId ??= new Map(
    Object.entries(registry).flatMap(([name, entry]) => {
      const id = (entry.pipeline as { workflowId?: string }).workflowId;
      return id === undefined ? [] : [[id, name] as [string, string]];
    }),
  );
  return pipelineByWorkflowId.get(workflowName) ?? workflowName;
}

const worldRunExists = (runId: string) => getRun(runId).exists;

const worldHookRunId = (token: string) =>
  getHookByToken(token).then(
    (hook) => hook.runId,
    () => null,
  );

// One page, deliberately: both the prefix scan and `jigs ps` are
// conveniences over a developer-scale run table, not indexes to page through.
async function worldRuns(): Promise<WorldRun[]> {
  const page = await getWorld().runs.list({
    resolveData: "none",
    pagination: { limit: 1000 },
  });
  return page.data.map((run) => ({
    runId: run.runId,
    workflowName: run.workflowName,
    status: run.status,
    createdAt: run.createdAt,
  }));
}

const worldRunIds = () => worldRuns().then((runs) => runs.map((r) => r.runId));

async function worldHookRunIds(): Promise<string[]> {
  const page = await getWorld().hooks.list({ pagination: { limit: 1000 } });
  return page.data.map((hook) => hook.runId);
}
