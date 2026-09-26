import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { factoryEnvValue } from "../../config/factory-env.ts";
import { locateFactoryRoot } from "../../config/factory-root.ts";
import { jigsDataDir } from "../../config/paths.ts";
import { JigsError } from "../../errors.ts";
import type { RegistrySql } from "../../steps/workspaces/registry.ts";
import type {
  ResourceEntry,
  ResourceInventory,
  ResourceRun,
} from "../../steps/workspaces/resources.ts";
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

interface RunRow {
  id: string;
  name: string;
  status: string;
  attributes: Record<string, string> | null;
}

async function readRuns(sql: RegistrySql): Promise<ResourceRun[]> {
  const result = await sql.$client.query<RunRow>(
    'select id, name, status, attributes from "workflow"."workflow_runs" order by created_at desc',
  );
  return result.rows.map((row) => ({
    runId: row.id,
    workflowName: row.name,
    status: row.status,
    attributes: row.attributes ?? {},
  }));
}

function emittedWorkflowIds(factoryRoot: string): Set<string> {
  const bundle = path.join(factoryRoot, ".output", "server", "index.mjs");
  if (!existsSync(bundle)) {
    throw new Error(`no built factory bundle at ${bundle}`);
  }
  const source = readFileSync(bundle, "utf8");
  return new Set(
    (source.match(/"workflow\/\/\.\/[^"@]+"/g) ?? []).map((match) => match.slice(1, -1)),
  );
}

function requireRun(runs: ResourceRun[], runId: string | undefined): string | undefined {
  if (runId === undefined || runs.some((run) => run.runId === runId)) return runId;
  throw runNotFound(runId);
}

async function readInventory(
  deps: ResourcesDeps,
  sql: RegistrySql,
  options: ResourcesOptions,
): Promise<{
  report: ResourceInventory;
  input: Parameters<typeof inventoryResources>[0];
}> {
  const factoryRoot = locateFactoryRoot(deps.cwd);
  const runs = await readRuns(sql).catch((error) => {
    throw new JigsError(
      `could not read workflow runs: ${String(error)}`,
      "check WORKFLOW_POSTGRES_URL and database availability; no resources were changed",
    );
  });
  const runId = requireRun(runs, options.run);
  const errors: string[] = [];
  const { listWorktrees } = await import("../../steps/workspaces/registry.ts");
  const worktrees = await listWorktrees(sql).catch((error) => {
    errors.push(`worktree registry read failed: ${String(error)}`);
    return [];
  });
  let ownedWorkflowIds = new Set<string>();
  try {
    ownedWorkflowIds = emittedWorkflowIds(factoryRoot);
    if (ownedWorkflowIds.size === 0)
      errors.push("the built factory bundle contains no workflow IDs");
  } catch (error) {
    errors.push(String(error));
  }
  const input = {
    runs,
    worktrees,
    factoryRoot,
    dataDir: jigsDataDir(),
    ownedWorkflowIds,
    ...(runId === undefined ? {} : { runId }),
    ...(options.includeKept === true ? { includeKept: true } : {}),
  };
  const { inventoryResources } = await import("../../steps/workspaces/resources.ts");
  const report = await inventoryResources(input);
  report.complete = errors.length === 0;
  report.errors.push(...errors);
  return { report, input };
}

function printEntry(entry: ResourceEntry, out: (line: string) => void): void {
  const existence = entry.exists === null ? "remote" : entry.exists ? "exists" : "missing";
  const decision = entry.eligible ? "remove" : "keep";
  out(
    `${entry.runId ?? "-"}  ${entry.status}  ${entry.kind}  ${existence}  ${decision}  ${entry.location}  ${entry.reason}`,
  );
}

function printReport(
  report: ResourceInventory,
  out: (line: string) => void,
  applied: boolean,
): void {
  for (const entry of report.entries) printEntry(entry, out);
  for (const error of report.errors) out(`incomplete: ${error}`);
  const removable = report.entries.filter((entry) => entry.eligible).length;
  const removed = report.entries.filter((entry) => entry.action === "remove").length;
  const failed = report.entries.filter((entry) => entry.error !== undefined).length;
  out(
    applied
      ? `${removed} removed, ${failed} failed, ${report.entries.length - removed} retained`
      : `${removable} proposed removal${removable === 1 ? "" : "s"}, ${report.entries.length - removable} retained; preview only`,
  );
}

function output(report: ResourceInventory, deps: ResourcesDeps, options: ResourcesOptions): void {
  if (options.json === true) {
    deps.out(JSON.stringify(report, null, 2));
  } else {
    printReport(report, deps.out, options.apply === true);
  }
}

function databaseUrl(factoryRoot: string): string {
  const url = factoryEnvValue(factoryRoot, "WORKFLOW_POSTGRES_URL");
  if (url === undefined) {
    throw new JigsError(
      "WORKFLOW_POSTGRES_URL is not set for this factory",
      "set it in the factory's .env; resource inspection reads the database without starting the service",
    );
  }
  return url;
}

async function withDatabase<T>(
  deps: ResourcesDeps,
  action: (sql: RegistrySql) => Promise<T>,
): Promise<T> {
  const root = locateFactoryRoot(deps.cwd);
  const connect =
    deps.connect ??
    ((url: string) =>
      import("../../steps/workspaces/registry.ts").then(({ connectRegistry }) =>
        connectRegistry(url, { max: 1 }),
      ));
  const sql = await connect(databaseUrl(root));
  try {
    return await action(sql);
  } finally {
    await sql.$client.end();
  }
}

export async function listResources(
  deps: ResourcesDeps,
  options: ResourcesOptions = {},
): Promise<ResourceInventory> {
  const report = await withDatabase(
    deps,
    async (sql) => (await readInventory(deps, sql, options)).report,
  );
  output(report, deps, options);
  return report;
}

export async function runResourcesPrune(
  deps: ResourcesDeps,
  options: ResourcesOptions = {},
): Promise<ResourceInventory> {
  if (options.apply !== true) {
    const report = await withDatabase(
      deps,
      async (sql) => (await readInventory(deps, sql, options)).report,
    );
    output(report, deps, options);
    return report;
  }

  const factoryRoot = locateFactoryRoot(deps.cwd);
  const { slug } = (await import("../../config/factory-config.ts")).resolveService(factoryRoot);
  const releaseExclusion = acquireServiceExclusion(slug, "resources-prune");
  try {
    requireServiceStopped({ cwd: factoryRoot, out: deps.out, processes: deps.processes });

    const report = await withDatabase(deps, async (sql) => {
      const { report: preview, input } = await readInventory(deps, sql, options);
      if (!preview.complete) {
        throw new JigsError(
          `resource inventory is incomplete: ${preview.errors.join("; ")}`,
          "fix every read/ownership error and rerun; no resources were changed",
        );
      }
      const { pruneResources } = await import("../../steps/workspaces/resources.ts");
      return pruneResources(input, sql);
    });
    output(report, deps, options);
    return report;
  } finally {
    releaseExclusion();
  }
}
