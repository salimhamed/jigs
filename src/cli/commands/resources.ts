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
import { columns, command, displayPath, formatTable, heading, note, tone } from "../output.ts";
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

/** A branch a finished run pushed that is still on GitHub; jigs never deletes remote branches. */
export interface LeftBranch {
  runId: string;
  /** `owner/repo:branch`. */
  identity: string;
  url: string;
  /** False when the remote could not be asked, so the branch may already be gone. */
  checked: boolean;
  /** How to delete it by hand. */
  command: string;
}

export interface ResourceInventory {
  complete: boolean;
  errors: string[];
  entries: ResourceEntry[];
  leftOnGitHub: LeftBranch[];
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

const NOT_FINISHED = "the run is not finished";

const modules = async () => ({
  ...(await import("../../config/factory-config.ts")),
  ...(await import("../../steps/workspaces/layout.ts")),
  ...(await import("../../steps/runtime/registry.ts")),
  ...(await import("../../steps/runtime/release.ts")),
  ...(await import("../../steps/runtime/resource-kinds.ts")),
  ...(await import("../../steps/runtime/run-state.ts")),
  ...(await import("../../providers/git.ts")),
});

/**
 * The branches finished runs left on GitHub, asking each clone's remote once which still exist.
 * On apply, the ones gone are marked released; a preview writes nothing.
 */
async function leftBranches(
  sql: RegistrySql,
  factory: string,
  options: ResourcesOptions,
): Promise<LeftBranch[]> {
  const m = await modules();
  const rows = await m.listResources(sql, {
    factory,
    ...(options.run === undefined ? {} : { runId: options.run }),
    kind: "branch",
    states: ["live"],
  });
  const statuses = new Map<string, boolean>();
  for (const runId of new Set(rows.map((row) => row.runId))) {
    statuses.set(
      runId,
      m.finished({ status: (await offlineFacts(sql)(runId)).run?.status ?? null }),
    );
  }
  const left: LeftBranch[] = [];
  for (const [repoDir, branches] of Map.groupBy(
    rows.filter((row) => statuses.get(row.runId)),
    (row) => row.repoDir ?? "",
  )) {
    const heads =
      repoDir === "" ? null : await m.tryGit(["ls-remote", "--heads", "origin"], repoDir);
    const existing =
      heads === null ? null : new Set(heads.split("\n").map((line) => line.split("\t")[1]));
    // Never offer the default branch for deletion, whatever the records say.
    const defaultBranch = repoDir === "" ? null : await m.deriveDefaultBranch(repoDir);
    for (const row of branches) {
      if (row.branch === defaultBranch) continue;
      if (existing !== null && !existing.has(`refs/heads/${row.branch}`)) {
        if (options.apply === true) {
          await m.setResourceState(sql, row, "released", "deleted outside jigs");
        }
        continue;
      }
      left.push({
        runId: row.runId,
        identity: row.identity,
        url: row.url,
        checked: existing !== null,
        command: `git push origin --delete ${row.branch}`,
      });
    }
  }
  return left;
}

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
        decision: NOT_FINISHED,
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

async function inventory(
  sql: RegistrySql,
  factory: string,
  options: ResourcesOptions,
): Promise<ResourceInventory> {
  const entries = await visit(sql, factory, options);
  const errors = entries.flatMap((entry) => (entry.error === undefined ? [] : [entry.error]));
  return {
    complete: errors.length === 0,
    errors,
    entries,
    leftOnGitHub: await leftBranches(sql, factory, options),
  };
}

function output(result: ResourceInventory, deps: ResourcesDeps, options: ResourcesOptions): void {
  if (options.json === true) {
    deps.out(JSON.stringify(result, null, 2));
    return;
  }
  const apply = options.apply === true;
  for (const [runId, entries] of Map.groupBy(result.entries, (entry) => entry.runId)) {
    deps.out(`${heading(runId)}  ${tone(entries[0]?.status ?? "unknown")}`);
    deps.out("");
    const overridden = new Set(entries.flatMap((entry) => overriddenReason(entry, apply) ?? []));
    const shared = overridden.size === 1 ? [...overridden][0] : undefined;
    const rows = entries.flatMap((entry) => {
      const outcome = apply ? appliedResult(entry) : entry.eligible ? "release" : "keep";
      const detail = entryDetail(entry, apply, shared);
      return [
        [entry.kind, tone(outcome), displayPath(entry.url)],
        ...(detail === undefined ? [] : [["", "", note(detail)]]),
      ];
    });
    for (const line of formatTable(["KIND", apply ? "RESULT" : "DECISION", "PATH"], rows)) {
      deps.out(`  ${line}`);
    }
    for (const line of runNotes(entries, shared)) deps.out(`  ${note(line)}`);
    deps.out("");
  }
  if (result.leftOnGitHub.length > 0) showLeftBranches(result.leftOnGitHub, deps);
  const { entries } = result;
  const removable = entries.filter((entry) => entry.eligible).length;
  const removed = entries.filter((entry) => entry.action === "remove").length;
  deps.out(
    apply
      ? `${removed} removed, ${result.errors.length} failed, ${entries.length - removed} retained`
      : `${removable} proposed removal${removable === 1 ? "" : "s"}, ${entries.length - removable} retained; preview only`,
  );
}

function appliedResult(entry: ResourceEntry): string {
  if (entry.action === "remove") return "removed";
  if (entry.decision === NOT_FINISHED) return "skipped";
  return entry.state === "live" ? "waiting" : entry.state;
}

/** The kept decision a preview would override, if it would override one. */
function overriddenReason(entry: ResourceEntry, apply: boolean): string | undefined {
  if (apply || !entry.eligible || entry.state !== "kept") return undefined;
  return entry.reason ?? undefined;
}

// What one resource adds beyond its outcome; a kept decision every overridden
// resource of the run shares is printed once below its table instead.
function entryDetail(
  entry: ResourceEntry,
  apply: boolean,
  shared: string | undefined,
): string | undefined {
  if (entry.decision === NOT_FINISHED) return undefined;
  if (apply) return entry.decision === "removed" ? undefined : entry.decision;
  if (!entry.eligible) return entry.decision;
  const overridden = overriddenReason(entry, apply);
  if (overridden !== undefined) {
    return overridden === shared ? undefined : `overrides the kept decision: ${overridden}`;
  }
  return entry.state === "failed" && entry.reason !== null
    ? `previous attempt: ${entry.reason}`
    : undefined;
}

function runNotes(entries: readonly ResourceEntry[], shared: string | undefined): string[] {
  return [
    ...(entries.some((entry) => entry.decision === NOT_FINISHED)
      ? [`${NOT_FINISHED}, so nothing is released`]
      : []),
    ...(shared === undefined ? [] : [`prune overrides the kept decision: ${shared}`]),
  ];
}

function showLeftBranches(branches: readonly LeftBranch[], deps: ResourcesDeps): void {
  deps.out(heading("Left on GitHub (jigs never deletes remote branches)"));
  const rows = branches.map((branch) => {
    const split = branch.identity.indexOf(":");
    const repo = branch.identity.slice(0, split);
    const name = branch.identity.slice(split + 1);
    return [
      repo,
      branch.checked ? name : `${name}  ${note("(could not check the remote; it may be gone)")}`,
    ];
  });
  for (const line of columns(rows)) deps.out(`  ${line}`);
  deps.out(
    note(
      branches.length === 1
        ? "  delete after the PR is merged or closed:"
        : "  delete each after its PR is merged or closed:",
    ),
  );
  for (const branch of branches) deps.out(`    ${command(branch.command)}`);
  deps.out("");
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
  const result = await withDatabase(deps, (sql, factory) => inventory(sql, factory, options));
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
    const result = await withDatabase(deps, (sql, factory) => inventory(sql, factory, options));
    output(result, deps, options);
    return result;
  } finally {
    releaseExclusion();
  }
}
