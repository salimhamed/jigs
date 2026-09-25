// The check catalog engine: one shared shape for every requirement check and
// its repair instruction, so preflight, JIT checks and `jigs doctor` render
// the same text at launch and mid-run.

import type { WorkflowRequires } from "./index.ts";

/** A check's outcome: a pass with an optional `detail`, or a failure with its repair. */
export type CheckResult =
  | { ok: true; detail?: string }
  | { ok: false; reason: string; repair: string };

/** One requirement check with a stable id and a label for reports. */
export interface Check {
  id: string;
  label: string;
  run(): Promise<CheckResult>;
}

export type CheckOutcome = { id: string; label: string } & CheckResult;

export type FailedCheck = Extract<CheckOutcome, { ok: false }>;

export interface CheckReport {
  ok: boolean;
  checks: CheckOutcome[];
}

// The trigger-path budget: one preflight or doctor check, and one phase of
// the JIT MCP check, which runs under the larger JIT_TIMEOUT_MS outer race.
export const CHECK_TIMEOUT_MS = 15_000;

// Strictly smaller: an inner probe that outlives the outer race loses its
// specific repair text to the generic "did not answer" line.
export const PROBE_TIMEOUT_MS = CHECK_TIMEOUT_MS - 3_000;

// Concurrent, bounded and total: one check throwing or hanging must not cost
// the report its other failures, because aggregation is the whole point.
export async function runChecks(
  checks: Check[],
  timeoutMs: number = CHECK_TIMEOUT_MS,
): Promise<CheckReport> {
  const outcomes = await Promise.all(
    checks.map(async (check): Promise<CheckOutcome> => {
      const timeout = new Promise<CheckResult>((resolve) => {
        // AbortSignal.timeout's timer is unref'd, so nothing to clean up.
        AbortSignal.timeout(timeoutMs).addEventListener("abort", () =>
          resolve({
            ok: false,
            reason: `the check did not answer within ${timeoutMs}ms`,
            repair: `the ${check.id} check did not answer within ${timeoutMs}ms — retry, and report this if it repeats`,
          }),
        );
      });
      const result = await Promise.race([check.run(), timeout]).catch(
        (err: unknown): CheckResult => ({
          ok: false,
          reason: String(err),
          repair: `the ${check.id} check itself failed — report this`,
        }),
      );
      return { id: check.id, label: check.label, ...result };
    }),
  );
  return { ok: outcomes.every((outcome) => outcome.ok), checks: outcomes };
}

export function failedChecks(report: CheckReport): FailedCheck[] {
  return report.checks.filter((outcome): outcome is FailedCheck => outcome.ok === false);
}

// The one shared renderer — the reason every caller reads the same repair.
export function formatFailures(report: CheckReport): string {
  return failedChecks(report)
    .map((failure) => `${failure.label}: ${failure.reason}\n  → ${failure.repair}`)
    .join("\n");
}

export function failedCheck(id: string, label: string, reason: string, repair: string): Check {
  return { id, label, run: async () => ({ ok: false, reason, repair }) };
}

/** A factory's workflows by name, as far as the check catalog reads them. */
export type WorkflowManifests = Record<string, { requires?: WorkflowRequires }>;

/** Map each requirement `pick` reads from a workflow's `requires` to the workflows that name it. */
export function requirementUsers<K extends string>(
  workflows: WorkflowManifests,
  pick: (requires: WorkflowRequires) => readonly K[],
): Map<K, string[]> {
  const users = new Map<K, string[]>();
  for (const [name, entry] of Object.entries(workflows)) {
    for (const requirement of new Set(pick(entry.requires ?? {}))) {
      users.set(requirement, [...(users.get(requirement) ?? []), name]);
    }
  }
  return users;
}

export function neededBy(workflows: readonly string[]): string {
  return `needed by ${workflows.length === 1 ? "workflow" : "workflows"} ${workflows.join(", ")}`;
}

// With no workflows, the factory configuration asked for these checks itself,
// and each check's own reason already says so.
export function neededByWorkflows(checks: Check[], workflows: readonly string[]): Check[] {
  if (workflows.length === 0) return checks;
  return checks.map((check) => ({
    ...check,
    run: async () => {
      const result = await check.run();
      return result.ok
        ? result
        : { ...result, reason: `${result.reason} (${neededBy(workflows)})` };
    },
  }));
}
