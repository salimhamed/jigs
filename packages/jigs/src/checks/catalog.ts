// The check catalog engine (ADR 0010): one shared shape for every
// requirement check and its repair instruction, so preflight, JIT checks and
// `jigs doctor` render the same text at launch and mid-run. The result shape
// generalizes the codex config guard's GuardResult — that guard registers
// here unchanged.

export type CheckResult =
  | { ok: true }
  | { ok: false; reason: string; repair: string };

export interface Check {
  id: string;
  label: string;
  run(): Promise<CheckResult>;
}

export type CheckOutcome = { id: string; label: string } & CheckResult;

export type FailedCheck = {
  id: string;
  label: string;
  ok: false;
  reason: string;
  repair: string;
};

export interface CheckReport {
  ok: boolean;
  checks: CheckOutcome[];
}

export const CHECK_TIMEOUT_MS = 15_000;

// Concurrent and total: one check throwing must not cost the report its
// other failures, because aggregation is the whole point.
export async function runChecks(checks: Check[]): Promise<CheckReport> {
  const outcomes = await Promise.all(
    checks.map(async (check): Promise<CheckOutcome> => {
      const result = await check.run().catch(
        (err: unknown): CheckResult => ({
          ok: false,
          reason: String(err),
          repair: `the ${check.id} check itself failed — report this, then re-run: jigs doctor`,
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
