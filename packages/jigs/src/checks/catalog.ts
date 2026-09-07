// The check catalog engine (ADR 0010): one shared shape for every
// requirement check and its repair instruction, so preflight, JIT checks and
// `jigs doctor` render the same text at launch and mid-run.

export type CheckResult =
  | { ok: true }
  | { ok: false; reason: string; repair: string };

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
  return report.checks.filter(
    (outcome): outcome is FailedCheck => outcome.ok === false,
  );
}

// The one shared renderer — the reason every caller reads the same repair.
export function formatFailures(report: CheckReport): string {
  return failedChecks(report)
    .map(
      (failure) => `${failure.label}: ${failure.reason}\n  → ${failure.repair}`,
    )
    .join("\n");
}

export function failedCheck(
  id: string,
  label: string,
  reason: string,
  repair: string,
): Check {
  return { id, label, run: async () => ({ ok: false, reason, repair }) };
}
