import { factoryEnvValue } from "../../config/factory-env.ts";
import { locateFactoryRoot } from "../../config/factory-root.ts";
import { JigsError } from "../../errors.ts";
import type { RegistrySql } from "../../steps/runtime/registry.ts";
import type { RunFacts } from "../../steps/runtime/run-state.ts";
import {
  RELEASABLE_KINDS,
  type ResourceRecord,
  UNRELEASED_STATES,
} from "../../workflow/runtime/resources.ts";
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
  /** Why prune would release the resource or leave it, or what applying it did. */
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
// run's status is the one World fact prune needs: whether anything will ever
// come back for the resource.
export const offlineFacts =
  (sql: RegistrySql) =>
  async (runId: string): Promise<RunFacts> => {
    const { rows } = await sql.$client.query<{ status: string }>(
      'select status from "workflow"."workflow_runs" where id = $1',
      [runId],
    );
    const status = rows[0]?.status;
    return {
      run:
        status === undefined
          ? null
          : { status, workflowName: null, trigger: null, ticket: null, createdAt: null },
    };
  };

const modules = async () => ({
  ...(await import("../../config/factory-config.ts")),
  ...(await import("../../steps/workspaces/layout.ts")),
  ...(await import("../../steps/runtime/registry.ts")),
  ...(await import("../../steps/runtime/release.ts")),
  ...(await import("../../steps/runtime/resource-kinds.ts")),
  ...(await import("../../steps/runtime/run-state.ts")),
});

/**
 * Visit one run's unreleased resources in release order. Prune overrides the release policy: a
 * resource the policy kept is released too, but only past the same safety checks as release. A
 * preview changes nothing but lets later kinds see what applying would do; applying writes each
 * outcome through `releaseOne`.
 */
async function visitRun(
  sql: RegistrySql,
  factory: string,
  runId: string,
  options: ResourcesOptions,
): Promise<ResourceEntry[]> {
  const m = await modules();
  const rows = await m.listResources(sql, { factory, runId, kinds: RELEASABLE_KINDS });
  const state = m.describeRunState(runId, await offlineFacts(sql)(runId), rows.map(m.toRecord));
  const entries: ResourceEntry[] = [];
  for (const row of m.releaseOrder(rows)) {
    if (row.state === "released") continue;
    const entry = { ...m.toRecord(row), status: state.status, eligible: false };
    if (!m.finished(state)) {
      entries.push({
        ...entry,
        decision: "the run is not finished",
        ...(options.apply ? { action: "skip" } : {}),
      });
      continue;
    }
    if (options.apply === true) {
      const after = await m.releaseOne(sql, row, rows);
      entries.push({
        ...entry,
        ...m.toRecord(after),
        eligible: true,
        decision: after.reason ?? after.state,
        action: after.state === "released" ? "remove" : "skip",
        ...(after.state === "failed" ? { error: `${row.identity}: ${after.reason}` } : {}),
      });
      continue;
    }
    const decided = await m
      .decideRelease(row, rows)
      .catch(
        (error: unknown) =>
          ({ state: "failed", reason: `could not check: ${String(error)}` }) as const,
      );
    const removes = typeof decided === "function" || decided.state === "released";
    const overrides = row.state === "kept" ? `; overrides the kept decision (${row.reason})` : "";
    entries.push({
      ...entry,
      eligible: removes,
      decision: removes ? `would be released${overrides}` : decided.reason,
    });
    if (removes) row.state = "released";
  }
  return entries;
}

async function visit(
  sql: RegistrySql,
  factory: string,
  options: ResourcesOptions,
): Promise<ResourceEntry[]> {
  const m = await modules();
  const rows = await m
    .listResources(sql, {
      factory,
      ...(options.run === undefined ? {} : { runId: options.run }),
      kinds: RELEASABLE_KINDS,
      states: UNRELEASED_STATES,
    })
    .catch((error) => {
      throw new JigsError(
        `could not read the jigs registry: ${String(error)}`,
        "check WORKFLOW_POSTGRES_URL and database availability; no resources were changed",
      );
    });
  if (options.run !== undefined && rows.length === 0) {
    if ((await offlineFacts(sql)(options.run)).run === null) throw runNotFound(options.run);
  }
  const entries: ResourceEntry[] = [];
  for (const runId of [...new Set(rows.map((row) => row.runId))].sort()) {
    // Under the run's lock, the records and the run's status are read afresh
    // and every decision is taken again, whatever the preview said.
    entries.push(
      ...(options.apply === true
        ? await m.withRunResourceLock(sql, runId, (locked) =>
            visitRun(locked, factory, runId, options),
          )
        : await visitRun(sql, factory, runId, options)),
    );
  }
  return entries;
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
  const result = report(await withDatabase(deps, (sql, factory) => visit(sql, factory, options)));
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
    const result = report(await withDatabase(deps, (sql, factory) => visit(sql, factory, options)));
    output(result, deps, options);
    return result;
  } finally {
    releaseExclusion();
  }
}
