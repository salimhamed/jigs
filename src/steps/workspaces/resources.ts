import { existsSync, lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { cleanupFromAttributes } from "../../blocks/runtime/cleanup.ts";
import { type RunResource, resourcesFromAttributes } from "../../blocks/runtime/resources.ts";
import { TERMINAL_RUN_STATUSES } from "../../run-status.ts";
import { factorySlug } from "./layout.ts";
import {
  deleteWorktree,
  listWorktrees,
  type RegistrySql,
  type WorktreeRow,
  withRunResourceLock,
} from "./registry.ts";
import { applyTeardown, countUnmergedCommits, isWorktreeDirty } from "./teardown.ts";

export interface ResourceRun {
  runId: string;
  workflowName: string;
  status: string;
  attributes: Record<string, string>;
}

export interface ResourceEntry {
  runId: string | null;
  status: string;
  kind: string;
  identity: string;
  location: string;
  exists: boolean | null;
  registered: boolean;
  ownership: "factory" | "other-factory" | "unknown";
  kept: boolean;
  eligible: boolean;
  reason: string;
  branch?: string;
  action?: "remove" | "skip";
  error?: string;
}

export interface ResourceInventory {
  complete: boolean;
  errors: string[];
  entries: ResourceEntry[];
}

export interface ResourceInventoryInput {
  runs: ResourceRun[];
  worktrees: WorktreeRow[];
  factoryRoot: string;
  dataDir: string;
  ownedWorkflowIds: ReadonlySet<string>;
  includeKept?: boolean;
  runId?: string;
}

interface ResourceRunRow {
  id: string;
  name: string;
  status: string;
  attributes: Record<string, string> | null;
}

interface ClassifiedResource {
  entry: ResourceEntry;
  row?: WorktreeRow;
  path?: string;
}

const resourceKey = (resource: Pick<RunResource, "kind" | "identity">): string =>
  `${resource.kind}\0${resource.identity}`;

const within = (parent: string, child: string): boolean => {
  const relative = path.relative(parent, child);
  return (
    relative !== "" &&
    !relative.startsWith(`..${path.sep}`) &&
    relative !== ".." &&
    !path.isAbsolute(relative)
  );
};

function localPath(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "file:") return null;
    return fileURLToPath(parsed);
  } catch {
    return null;
  }
}

function diskSafety(
  target: string,
  root: string,
): { safe: boolean; exists: boolean; reason?: string } {
  if (!within(root, target))
    return {
      safe: false,
      exists: existsSync(target),
      reason: "path is outside this factory's managed root",
    };
  if (!existsSync(target)) return { safe: true, exists: false };
  try {
    const stat = lstatSync(target);
    if (stat.isSymbolicLink())
      return { safe: false, exists: true, reason: "path is a symbolic link" };
    if (!stat.isDirectory())
      return { safe: false, exists: true, reason: "path is not a directory" };
    const realRoot = realpathSync(root);
    const realTarget = realpathSync(target);
    if (!within(realRoot, realTarget)) {
      return {
        safe: false,
        exists: true,
        reason: "path resolves outside this factory's managed root",
      };
    }
    return { safe: true, exists: true };
  } catch (error) {
    return { safe: false, exists: true, reason: `path could not be verified: ${String(error)}` };
  }
}

function retention(run: ResourceRun): { kept: boolean; decided: boolean; reason: string } {
  const cleanup = cleanupFromAttributes(run.attributes);
  const action =
    cleanup.action ?? (cleanup.directive === "automatic" ? undefined : cleanup.directive);
  if (action === "keep" || cleanup.status === "kept") {
    return {
      kept: true,
      decided: true,
      reason: "the run's recorded cleanup decision keeps resources",
    };
  }
  if (action === "release" || cleanup.status === "complete") {
    return {
      kept: false,
      decided: true,
      reason: "the run's recorded cleanup decision releases resources",
    };
  }
  return {
    kept: false,
    decided: false,
    reason:
      "the run has no recorded cleanup decision; start and stop the service once to reconcile it",
  };
}

function baseEntry(run: ResourceRun, resource: RunResource, owned: boolean): ResourceEntry {
  return {
    runId: run.runId,
    status: run.status,
    kind: resource.kind,
    identity: resource.identity,
    location: resource.url,
    exists: null,
    registered: true,
    ownership: owned ? "factory" : "other-factory",
    kept: false,
    eligible: false,
    reason: owned
      ? "resource kind is observation-only"
      : "the run's workflow is not emitted by this factory",
  };
}

async function classifyWorktree(
  run: ResourceRun,
  resource: RunResource,
  row: WorktreeRow | undefined,
  input: ResourceInventoryInput,
): Promise<ClassifiedResource> {
  const owned = input.ownedWorkflowIds.has(run.workflowName);
  const entry = baseEntry(run, resource, owned);
  const target = localPath(resource.url);
  if (!owned) return { entry };
  if (target === null || target !== resource.identity) {
    entry.reason = "worktree registration is not an exact local file URL for its identity";
    return { entry };
  }
  if (row === undefined || row.ownerRunId !== run.runId) {
    entry.ownership = "unknown";
    entry.exists = existsSync(target);
    entry.reason = "no matching worktree registry ownership record";
    return { entry, path: target };
  }
  // The caller supplies only rows from the shared registry. Ownership is proved
  // by the selected factory's slug in both the bare clone and worktree paths.
  const managedRoot = path.join(input.dataDir, "bindings", factorySlug(input.factoryRoot));
  const bindingRoot = path.dirname(row.repoDir);
  const worktreeRoot = path.join(bindingRoot, "worktrees");
  if (
    path.basename(row.repoDir) !== "repo.git" ||
    !within(managedRoot, row.repoDir) ||
    !within(managedRoot, target) ||
    !within(worktreeRoot, target)
  ) {
    entry.ownership = "other-factory";
    entry.exists = existsSync(target);
    entry.reason = "registry paths do not belong to this factory binding";
    return { entry, row, path: target };
  }
  const safety = diskSafety(target, managedRoot);
  entry.exists = safety.exists;
  if (!safety.safe) {
    entry.reason = safety.reason as string;
    return { entry, row, path: target };
  }
  if (!TERMINAL_RUN_STATUSES.has(run.status)) {
    entry.reason = "the owning run is not terminal";
    return { entry, row, path: target };
  }
  const decision = retention(run);
  entry.kept = decision.kept;
  if (!decision.decided) {
    entry.reason = decision.reason;
    return { entry, row, path: target };
  }
  if (decision.kept && input.includeKept !== true) {
    entry.reason = `${decision.reason}; pass --include-kept to consider it`;
    return { entry, row, path: target };
  }
  if (!safety.exists) {
    entry.eligible = true;
    entry.reason = "registered worktree is absent; its stale registry row can be removed";
    return { entry, row, path: target };
  }
  if (await isWorktreeDirty(target)) {
    entry.reason = "worktree is dirty and is preserved";
    return { entry, row, path: target };
  }
  const unmerged = await countUnmergedCommits(row.repoDir, row.branch);
  if (unmerged === null) {
    entry.reason = "branch ancestry could not be verified";
    return { entry, row, path: target };
  }
  if (unmerged > 0) {
    entry.reason = `branch has ${unmerged} unmerged commit${unmerged === 1 ? "" : "s"} and is preserved`;
    return { entry, row, path: target };
  }
  entry.branch = row.branch;
  entry.eligible = true;
  entry.reason = decision.kept
    ? "kept resource explicitly included; worktree is clean and fully merged"
    : "worktree is clean and fully merged";
  return { entry, row, path: target };
}

function classifyRunDirectory(
  run: ResourceRun,
  resource: RunResource,
  input: ResourceInventoryInput,
): ClassifiedResource {
  const owned = input.ownedWorkflowIds.has(run.workflowName);
  const entry = baseEntry(run, resource, owned);
  const expected = path.join(input.dataDir, "scratch", run.runId);
  const target = localPath(resource.url);
  if (!owned) return { entry };
  if (
    resource.identity !== run.runId ||
    target !== expected ||
    pathToFileURL(expected).href !== resource.url
  ) {
    entry.reason =
      "run-directory registration does not exactly name this run's tracked scratch directory";
    return { entry };
  }
  const safety = diskSafety(expected, path.join(input.dataDir, "scratch"));
  entry.exists = safety.exists;
  if (!safety.safe) {
    entry.reason = safety.reason as string;
    return { entry, path: expected };
  }
  if (!TERMINAL_RUN_STATUSES.has(run.status)) {
    entry.reason = "the owning run is not terminal";
    return { entry, path: expected };
  }
  const decision = retention(run);
  entry.kept = decision.kept;
  if (!decision.decided) {
    entry.reason = decision.reason;
    return { entry, path: expected };
  }
  if (decision.kept && input.includeKept !== true) {
    entry.reason = `${decision.reason}; pass --include-kept to consider it`;
    return { entry, path: expected };
  }
  if (!safety.exists) {
    entry.reason = "registered run directory is already absent";
    return { entry, path: expected };
  }
  entry.eligible = true;
  entry.reason = decision.kept
    ? "kept resource explicitly included; tracked scratch directory can be removed"
    : "tracked scratch directory can be removed";
  return { entry, path: expected };
}

async function classify(input: ResourceInventoryInput): Promise<ClassifiedResource[]> {
  const rowsByPath = new Map(input.worktrees.map((row) => [row.path, row]));
  const runs =
    input.runId === undefined ? input.runs : input.runs.filter((run) => run.runId === input.runId);
  const classified: ClassifiedResource[] = [];
  const registeredWorktrees = new Set<string>();
  for (const run of runs) {
    for (const resource of resourcesFromAttributes(run.attributes)) {
      if (resource.kind === "worktree") {
        const target = localPath(resource.url);
        if (target !== null) registeredWorktrees.add(target);
        classified.push(
          await classifyWorktree(
            run,
            resource,
            target === null ? undefined : rowsByPath.get(target),
            input,
          ),
        );
      } else if (resource.kind === "run-directory") {
        classified.push(classifyRunDirectory(run, resource, input));
      } else {
        classified.push({
          entry: baseEntry(run, resource, input.ownedWorkflowIds.has(run.workflowName)),
        });
      }
    }
  }
  const runById = new Map(input.runs.map((run) => [run.runId, run]));
  for (const row of input.worktrees) {
    if (input.runId !== undefined && row.ownerRunId !== input.runId) continue;
    if (registeredWorktrees.has(row.path)) continue;
    const run = runById.get(row.ownerRunId);
    const managedRoot = path.join(input.dataDir, "bindings", factorySlug(input.factoryRoot));
    const rowOwned = within(managedRoot, row.repoDir) && within(managedRoot, row.path);
    classified.push({
      row,
      path: row.path,
      entry: {
        runId: row.ownerRunId,
        status: run?.status ?? "unknown",
        kind: "worktree",
        identity: row.path,
        location: pathToFileURL(row.path).href,
        exists: existsSync(row.path),
        registered: false,
        ownership: run === undefined ? "unknown" : rowOwned ? "factory" : "other-factory",
        kept: false,
        eligible: false,
        reason: "worktree is in the registry but is not registered on its run",
      },
    });
  }
  return classified.sort(
    (left, right) =>
      (left.entry.runId ?? "").localeCompare(right.entry.runId ?? "") ||
      resourceKey(left.entry).localeCompare(resourceKey(right.entry)),
  );
}

export async function inventoryResources(
  input: ResourceInventoryInput,
): Promise<ResourceInventory> {
  return { complete: true, errors: [], entries: (await classify(input)).map(({ entry }) => entry) };
}

/** Read the deletion authority from the client that holds the run resource lock. */
export async function readResourceRun(
  sql: RegistrySql,
  runId: string,
): Promise<ResourceRun | null> {
  const result = await sql.$client.query<ResourceRunRow>(
    'select id, name, status, attributes from "workflow"."workflow_runs" where id = $1',
    [runId],
  );
  const row = result.rows[0];
  return row === undefined
    ? null
    : {
        runId: row.id,
        workflowName: row.name,
        status: row.status,
        attributes: row.attributes ?? {},
      };
}

export async function pruneResources(
  input: ResourceInventoryInput,
  sql: RegistrySql,
  withLock: <T>(
    sql: RegistrySql,
    runId: string,
    action: (locked: RegistrySql) => Promise<T>,
  ) => Promise<T> = (database, runId, action) => withRunResourceLock(database, runId, action),
  readRun: (sql: RegistrySql, runId: string) => Promise<ResourceRun | null> = readResourceRun,
): Promise<ResourceInventory> {
  const initial = await classify(input);
  const results: ResourceEntry[] = [];
  for (const candidate of initial) {
    if (!candidate.entry.eligible || candidate.entry.runId === null) {
      results.push({ ...candidate.entry, action: "skip" });
      continue;
    }
    try {
      const applied = await withLock(sql, candidate.entry.runId, async (locked) => {
        // Preview state is observability only. Status, retention attributes,
        // resource registration and registry ownership all come from the
        // authoritative database client after this run's advisory lock is held.
        const freshRun = await readRun(locked, candidate.entry.runId as string);
        const freshRows = await listWorktrees(locked);
        const fresh = await classify({
          ...input,
          runs: freshRun === null ? [] : [freshRun],
          worktrees: freshRows,
          runId: candidate.entry.runId as string,
        });
        const current = fresh.find(
          (item) =>
            item.entry.kind === candidate.entry.kind &&
            item.entry.identity === candidate.entry.identity,
        );
        if (current === undefined || !current.entry.eligible) {
          return {
            ...(current?.entry ?? candidate.entry),
            eligible: false,
            action: "skip" as const,
            reason: current?.entry.reason ?? "resource disappeared during apply revalidation",
          };
        }
        if (current.entry.kind === "worktree" && current.row !== undefined) {
          if (current.entry.exists) {
            await applyTeardown(
              {
                removeWorktree: true,
                force: false,
                deleteLocalBranch: true,
                deleteRemoteBranch: false,
                preserve: null,
              },
              {
                repoDir: current.row.repoDir,
                worktreePath: current.row.path,
                branch: current.row.branch,
              },
            );
          }
          await deleteWorktree(locked, current.row.path);
        } else if (current.entry.kind === "run-directory" && current.path !== undefined) {
          const { rm } = await import("node:fs/promises");
          await rm(current.path, { recursive: true, force: true });
        }
        return { ...current.entry, action: "remove" as const, reason: "removed" };
      });
      results.push(applied);
    } catch (error) {
      results.push({
        ...candidate.entry,
        action: "skip",
        error: String(error),
        reason: `removal failed; resource retained: ${String(error)}`,
      });
    }
  }
  return {
    complete: results.every((entry) => entry.error === undefined),
    errors: results.flatMap((entry) => (entry.error === undefined ? [] : [entry.error])),
    entries: results,
  };
}
