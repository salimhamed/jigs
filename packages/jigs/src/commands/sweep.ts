import { CliError } from "../errors.ts";
import type { SweepEntry } from "../worktrees/sweep.ts";
import { type ServiceDeps, serviceFetch } from "./service.ts";

// An HTTP client of the service (ADR 0008): the registry and the run states
// the sweep joins against live in the service's process, not the shell's.

export interface SweepOptions {
  clean?: boolean;
  force?: boolean;
}

export interface SweepResult {
  entries: SweepEntry[];
  removed: string[];
  removedDirs: string[];
}

export async function sweepWorktrees(
  deps: ServiceDeps,
  options: SweepOptions = {},
): Promise<SweepResult> {
  const clean = options.clean === true;
  const force = options.force === true;
  if (force && !clean) {
    throw new CliError(
      "--force only applies with --clean",
      "add --clean to delete, or drop --force to report",
    );
  }
  const res = await serviceFetch(deps.serviceUrl, "/api/worktrees/sweep", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ clean, force }),
  });
  if (!res.ok) {
    throw new CliError(`sweep failed: HTTP ${res.status} ${await res.text()}`);
  }
  const result = (await res.json()) as SweepResult;
  printEntries(result, deps.out);
  return result;
}

function printEntries(result: SweepResult, out: (line: string) => void): void {
  if (result.entries.length === 0) {
    out("no worktrees");
  } else {
    const width = Math.max(
      ...result.entries.map((entry) => entry.state.length),
    );
    for (const entry of result.entries) {
      const owner = entry.ownerRunId ?? "-";
      out(
        `${entry.state.padEnd(width)}  ${entry.path}  ${owner}  ${entry.reason}`,
      );
    }
  }
  const held = result.entries.filter((entry) => !entry.eligible).length;
  const needForce = result.entries.filter(
    (entry) => entry.eligible && entry.requiresForce,
  ).length;
  const dirs =
    result.removedDirs.length === 0
      ? ""
      : `, ${result.removedDirs.length} empty dir(s) removed`;
  out(
    `${result.removed.length} removed, ${held} held, ${needForce} need --force${dirs}`,
  );
}
