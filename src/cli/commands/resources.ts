import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { RUN_TICKET_ATTRIBUTE } from "../../blocks/factory.ts";
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
import {
  acquireServiceExclusion,
  liveServicePid,
  serviceSupervision,
} from "./service-lifecycle.ts";
import { type SystemdUserManager, systemdUserManager } from "./systemd-user.ts";

export interface ResourcesOptions {
  run?: string;
  json?: boolean;
  apply?: boolean;
  includeKept?: boolean;
}

export interface ResourcesDeps {
  cwd: string;
  out: (line: string) => void;
  systemd?: SystemdUserManager;
  connect?: (url: string) => RegistrySql;
}

interface RunRow {
  id: string;
  name: string;
  status: string;
  attributes: Record<string, string> | null;
}

interface SelectableResourceRun extends ResourceRun {
  ticket: string | null;
}

async function readRuns(sql: RegistrySql): Promise<SelectableResourceRun[]> {
  const result = await sql.$client.query<RunRow>(
    'select id, name, status, attributes from "workflow"."workflow_runs" order by created_at desc',
  );
  return result.rows.map((row) => ({
    runId: row.id,
    workflowName: row.name,
    status: row.status,
    attributes: row.attributes ?? {},
    ticket: row.attributes?.[RUN_TICKET_ATTRIBUTE] ?? null,
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

function resolveRun(runs: SelectableResourceRun[], ref: string | undefined): string | undefined {
  if (ref === undefined) return undefined;
  const exact = runs.find((run) => run.runId === ref);
  if (exact !== undefined) return exact.runId;
  const prefix = ref.startsWith("wrun_") ? ref : `wrun_${ref}`;
  const matches = runs.filter((run) => run.runId.startsWith(prefix));
  if (matches.length === 1) return matches[0]?.runId;
  if (matches.length > 1) {
    throw new JigsError(
      `run ${ref} is ambiguous`,
      `matches: ${matches.map((run) => run.runId).join(", ")}`,
    );
  }
  const normalized = ref.toLowerCase();
  const ticketMatches = runs.filter((run) => run.ticket?.toLowerCase() === normalized);
  if (ticketMatches.length === 1) return ticketMatches[0]?.runId;
  if (ticketMatches.length > 1) {
    throw new JigsError(
      `run ref ${ref} is ambiguous`,
      `matches: ${ticketMatches.map((run) => run.runId).join(", ")} — use a run ID or unique prefix`,
    );
  }
  throw new JigsError(`run ${ref} not found`);
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
  const runId = resolveRun(runs, options.run);
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
    const systemd = deps.systemd ?? systemdUserManager;
    if (!systemd.available()) {
      throw new JigsError(
        "cannot prove the factory's child processes are stopped without systemd user scopes",
        "run preview only here, or perform --apply on the supervised host after pnpm exec jigs service stop",
      );
    }
    const pid = liveServicePid({ cwd: factoryRoot, out: deps.out });
    if (pid !== undefined) {
      throw new JigsError(
        `factory service is still running as pid ${pid}`,
        "stop it first with pnpm exec jigs service stop; prune never stops or kills processes",
      );
    }
    if (serviceSupervision(slug) !== "systemd-scope") {
      throw new JigsError(
        "cannot prove that prior factory child processes were contained in its systemd scope",
        "start and stop this factory once with the current jigs service command, then retry; prune never stops or kills processes",
      );
    }
    const scope = systemd.scopeState(`jigs-${slug}`);
    if (scope !== "inactive") {
      throw new JigsError(
        scope === "active"
          ? `factory scope jigs-${slug}.scope still has a service or child process`
          : `could not verify that factory scope jigs-${slug}.scope is inactive`,
        "stop the surviving process and verify the user scope is inactive; prune never kills it",
      );
    }

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
