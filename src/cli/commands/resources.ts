import { factoryEnvValue } from "../../config/factory-env.ts";
import { locateFactoryRoot } from "../../config/factory-root.ts";
import { JigsError } from "../../errors.ts";
import { TERMINAL_RUN_STATUSES } from "../../run-status.ts";
import type { RegistrySql, ResourceRow } from "../../steps/runtime/registry.ts";
import type { WorldRunFacts } from "../../steps/runtime/run-state.ts";
import type { ResourceRecord, RunState } from "../../workflow/runtime/resources.ts";
import { runNotFound } from "./service-client.ts";
import {
  acquireServiceExclusion,
  requireServiceStopped,
  type ServiceProcesses,
} from "./service-lifecycle.ts";

export interface ResourcesOptions {
  run?: string;
  json?: boolean;
  apply?: boolean;
  includeKept?: boolean;
}

export interface ResourcesDeps {
  cwd: string;
  out: (line: string) => void;
  processes?: ServiceProcesses;
  connect?: (url: string) => RegistrySql;
}

export interface ResourceEntry extends ResourceRecord {
  /** The owning run's World status, or null when the World has no such run. */
  status: string | null;
  eligible: boolean;
  /** Why prune would release the resource or leave it. */
  decision: string;
  action?: "remove" | "skip";
  error?: string;
}

export interface ResourceInventory {
  complete: boolean;
  errors: string[];
  entries: ResourceEntry[];
}

// The CLI never opens the World, and prune runs with the service stopped. The
// run's status column is the one World fact prune needs: whether anything will
// ever come back for the resource.
const offlineWorld =
  (sql: RegistrySql) =>
  async (runId: string): Promise<WorldRunFacts> => {
    const { rows } = await sql.$client.query<{ status: string; name: string }>(
      'select status, name from "workflow"."workflow_runs" where id = $1',
      [runId],
    );
    return { status: rows[0]?.status ?? null, workflowName: rows[0]?.name ?? null, tokens: [] };
  };

const modules = async () => ({
  ...(await import("../../config/factory-config.ts")),
  ...(await import("../../steps/workspaces/layout.ts")),
  ...(await import("../../steps/runtime/registry.ts")),
  ...(await import("../../steps/runtime/resource-kinds.ts")),
  ...(await import("../../steps/runtime/run-state.ts")),
});

async function evaluate(
  row: ResourceRow,
  state: RunState,
  options: ResourcesOptions,
): Promise<ResourceEntry> {
  const { releasable, releaseRefusal, toRecord } = await modules();
  const entry = { ...toRecord(row), status: state.status, eligible: false };
  const leave = (decision: string): ResourceEntry => ({ ...entry, decision });
  if (!releasable(row.kind)) return leave("recorded only");
  if (row.state === "released") return leave("already released");
  if (row.state === "failed") return leave("an earlier release failed; the service retries it");
  if (state.status !== null && !TERMINAL_RUN_STATUSES.has(state.status)) {
    return leave("the run is not finished");
  }
  if (row.state === "kept" && options.includeKept !== true) {
    return leave("kept; pass --include-kept to consider it");
  }
  const refusal = await releaseRefusal(row, state.resources);
  if (refusal !== null) return leave(refusal);
  return { ...entry, eligible: true, decision: "would be released" };
}

async function inventory(
  sql: RegistrySql,
  factory: string,
  options: ResourcesOptions,
): Promise<ResourceEntry[]> {
  const { listResources, readRunState, releaseOrder } = await modules();
  const rows = await listResources(sql, {
    factory,
    ...(options.run === undefined ? {} : { runId: options.run }),
    states: ["live", "kept", "failed"],
  }).catch((error) => {
    throw new JigsError(
      `could not read the jigs registry: ${String(error)}`,
      "check WORKFLOW_POSTGRES_URL and database availability; no resources were changed",
    );
  });
  if (options.run !== undefined && rows.length === 0) {
    if ((await offlineWorld(sql)(options.run)).status === null) throw runNotFound(options.run);
  }
  const states = new Map<string, RunState>();
  for (const runId of new Set(rows.map((row) => row.runId))) {
    states.set(runId, await readRunState(sql, factory, runId, offlineWorld(sql)));
  }
  const ordered = releaseOrder(rows).sort((left, right) => left.runId.localeCompare(right.runId));
  return Promise.all(
    ordered.map((row) => evaluate(row, states.get(row.runId) as RunState, options)),
  );
}

async function prune(
  sql: RegistrySql,
  factory: string,
  options: ResourcesOptions,
): Promise<ResourceEntry[]> {
  const { listResources, readRunState, releaseResource, setResourceState, withRunResourceLock } =
    await modules();
  const results: ResourceEntry[] = [];
  for (const candidate of await inventory(sql, factory, options)) {
    if (!candidate.eligible) {
      results.push({ ...candidate, action: "skip" });
      continue;
    }
    // The preview is observability only: under the run's lock, the record and
    // the run's status are read again and the decision is taken afresh.
    const applied = await withRunResourceLock(sql, candidate.runId, async (locked) => {
      const state = await readRunState(locked, factory, candidate.runId, offlineWorld(locked));
      const [row] = await listResources(locked, {
        factory,
        runId: candidate.runId,
        kind: candidate.kind,
        identity: candidate.identity,
      });
      if (row === undefined) {
        return {
          ...candidate,
          eligible: false,
          action: "skip" as const,
          decision: "record disappeared",
        };
      }
      const fresh = await evaluate(row, state, options);
      if (!fresh.eligible) return { ...fresh, action: "skip" as const };
      const outcome = await releaseResource(row, state.resources);
      await setResourceState(locked, row, outcome.state, outcome.reason);
      return {
        ...fresh,
        state: outcome.state,
        reason: outcome.reason,
        decision: outcome.state === "released" ? "released" : outcome.reason,
        action: outcome.state === "released" ? ("remove" as const) : ("skip" as const),
        ...(outcome.state === "failed" ? { error: outcome.reason } : {}),
      };
    });
    results.push(applied);
  }
  return results;
}

function report(entries: ResourceEntry[]): ResourceInventory {
  const errors = entries.flatMap((entry) => (entry.error === undefined ? [] : [entry.error]));
  return { complete: errors.length === 0, errors, entries };
}

function output(result: ResourceInventory, deps: ResourcesDeps, options: ResourcesOptions): void {
  if (options.json === true) {
    deps.out(JSON.stringify(result, null, 2));
    return;
  }
  for (const entry of result.entries) {
    deps.out(
      `${entry.runId}  ${entry.status ?? "unknown"}  ${entry.kind}  ${entry.state}  ${entry.eligible ? "release" : "keep"}  ${entry.url}  ${entry.decision}`,
    );
  }
  for (const error of result.errors) deps.out(`failed: ${error}`);
  const { entries } = result;
  const removable = entries.filter((entry) => entry.eligible).length;
  const removed = entries.filter((entry) => entry.action === "remove").length;
  deps.out(
    options.apply === true
      ? `${removed} removed, ${result.errors.length} failed, ${entries.length - removed} retained`
      : `${removable} proposed removal${removable === 1 ? "" : "s"}, ${entries.length - removable} retained; preview only`,
  );
}

async function withDatabase<T>(
  deps: ResourcesDeps,
  action: (sql: RegistrySql, factory: string) => Promise<T>,
): Promise<T> {
  const root = locateFactoryRoot(deps.cwd);
  const url = factoryEnvValue(root, "WORKFLOW_POSTGRES_URL");
  if (url === undefined) {
    throw new JigsError(
      "WORKFLOW_POSTGRES_URL is not set for this factory",
      "set it in the factory's .env; resource inspection reads the database without starting the service",
    );
  }
  const { connectRegistry, factorySlug } = await modules();
  const sql = (deps.connect ?? ((value) => connectRegistry(value, { max: 1 })))(url);
  try {
    return await action(sql, factorySlug(root));
  } finally {
    await sql.$client.end();
  }
}

export async function listResources(
  deps: ResourcesDeps,
  options: ResourcesOptions = {},
): Promise<ResourceInventory> {
  const result = report(
    await withDatabase(deps, (sql, factory) => inventory(sql, factory, options)),
  );
  output(result, deps, options);
  return result;
}

export async function runResourcesPrune(
  deps: ResourcesDeps,
  options: ResourcesOptions = {},
): Promise<ResourceInventory> {
  if (options.apply !== true) return listResources(deps, options);
  const factoryRoot = locateFactoryRoot(deps.cwd);
  const { resolveService } = await modules();
  const releaseExclusion = acquireServiceExclusion(
    resolveService(factoryRoot).slug,
    "resources-prune",
  );
  try {
    requireServiceStopped({ cwd: factoryRoot, out: deps.out, processes: deps.processes });
    const result = report(await withDatabase(deps, (sql, factory) => prune(sql, factory, options)));
    output(result, deps, options);
    return result;
  } finally {
    releaseExclusion();
  }
}
