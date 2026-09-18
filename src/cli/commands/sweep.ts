import { JigsError } from "../../errors.ts";
import { type ServiceDeps, serviceFetch } from "./service-client.ts";

// An HTTP client of the service: the registry and the run states the sweep
// joins against live in the service's process, not the shell's.
//
// Nothing here runs unattended: a bare sweep reports and, on a terminal, asks
// per worktree; --force is the explicit yes-to-everything. There is no
// background pass — what sweep doesn't remove stays until an operator acts.

export interface SweepOptions {
  force?: boolean;
  paths?: string[];
}

export interface SweepDeps extends ServiceDeps {
  confirm?: (question: string) => Promise<boolean>;
}

// One entry of the service's sweep report, as this client prints it. The
// branch outcome rides along on the entry the pass removed — what happened to
// a branch is the service's decision, never re-derived here.
export interface SweepEntry {
  path: string;
  branch: string;
  kind?: "worktree" | "run-directory";
  state: string;
  eligible: boolean;
  requiresForce: boolean;
  ownerRunId?: string;
  reason: string;
  branchOutcome?: { deleted: boolean; unmergedCommits?: number };
}

export interface SweepResult {
  entries: SweepEntry[];
  removed: string[];
  removedDirs: string[];
}

export async function runSweep(deps: SweepDeps, options: SweepOptions = {}): Promise<SweepResult> {
  if (options.paths !== undefined) {
    const result = await postSweep(deps, {
      clean: true,
      force: true,
      paths: options.paths,
    });
    const removed = new Set(result.removed);
    const scopedResult = {
      ...result,
      entries: result.entries.filter((entry) => removed.has(entry.path)),
    };
    printEntries(scopedResult.entries, deps.out);
    printSummary(scopedResult, deps.out);
    return result;
  }

  if (options.force === true) {
    const result = await postSweep(deps, { clean: true, force: true });
    printEntries(result.entries, deps.out);
    printSummary(result, deps.out);
    return result;
  }

  const report = await postSweep(deps, { clean: false, force: false });
  const eligible = report.entries.filter((entry) => entry.eligible);
  if (deps.confirm === undefined || eligible.length === 0) {
    printEntries(report.entries, deps.out);
    printSummary(report, deps.out);
    // A bare sweep only reports; without this line "0 removed" beside an
    // eligible tree reads as a failed cleanup rather than a withheld one.
    if (eligible.length > 0) {
      deps.out(
        `report only — rerun in a terminal to be asked per worktree, or --force to remove all ${eligible.length}`,
      );
    }
    return report;
  }

  printEntries(
    report.entries.filter((entry) => !entry.eligible),
    deps.out,
  );
  const approved: string[] = [];
  for (const entry of eligible) {
    printEntries([entry], deps.out);
    const warning = entry.requiresForce ? " (HOLDS UNCOMMITTED WORK — removal is permanent)" : "";
    if (await deps.confirm(`remove ${entry.path}${warning}?`)) {
      approved.push(entry.path);
    }
  }
  if (approved.length === 0) {
    deps.out("nothing approved — nothing removed");
    return report;
  }
  // force accompanies the approvals because a dirty tree the operator just
  // said yes to needs it; the paths list is what scopes the deletion.
  const result = await postSweep(deps, {
    clean: true,
    force: true,
    paths: approved,
  });
  // The lines above were printed to be answered, before any branch outcome
  // existed; these say what the approvals came to.
  const removed = new Set(result.removed);
  printEntries(
    result.entries.filter((entry) => removed.has(entry.path)),
    deps.out,
  );
  printSummary(result, deps.out);
  return result;
}

async function postSweep(
  deps: SweepDeps,
  body: { clean: boolean; force: boolean; paths?: string[] },
): Promise<SweepResult> {
  const res = await serviceFetch(deps.serviceUrl, "/api/worktrees/sweep", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new JigsError(`sweep failed: HTTP ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as SweepResult;
}

function printEntries(entries: SweepEntry[], out: (line: string) => void) {
  if (entries.length === 0) return;
  const width = Math.max(...entries.map((entry) => entry.state.length));
  for (const entry of entries) {
    const owner = entry.ownerRunId ?? "-";
    out(
      `${entry.state.padEnd(width)}  ${entry.kind === "run-directory" ? "run-directory  " : ""}${entry.path}  ${owner}  ${entry.reason}${describeBranch(entry)}`,
    );
  }
}

function describeBranch(entry: SweepEntry): string {
  const outcome = entry.branchOutcome;
  if (outcome === undefined) return "";
  if (outcome.deleted) return " — branch deleted";
  const commits = outcome.unmergedCommits;
  if (commits === undefined || commits === 0) return " — branch kept";
  const plural = commits === 1 ? "" : "s";
  return ` — branch kept: ${commits} unmerged commit${plural}`;
}

function printSummary(result: SweepResult, out: (line: string) => void) {
  if (result.entries.length === 0) {
    out("no worktrees");
  }
  const held = result.entries.filter((entry) => !entry.eligible).length;
  const kept = result.entries.filter((entry) => entry.branchOutcome?.deleted === false).length;
  const branches = kept === 0 ? "" : ` (${kept} branch${kept === 1 ? "" : "es"} kept)`;
  const dirs =
    result.removedDirs.length === 0 ? "" : `, ${result.removedDirs.length} empty dir(s) removed`;
  out(`${result.removed.length} removed${branches}, ${held} held${dirs}`);
}
