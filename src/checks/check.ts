/**
 * A check's outcome: a pass with an optional `detail`, or a failure with its repair. A repair
 * quotes each command to run in backticks.
 *
 * @group Advanced driver contracts
 */
export type CheckResult =
  | { ok: true; detail?: string }
  | { ok: false; reason: string; repair: string };

/**
 * One requirement check with a stable id and a label for reports.
 *
 * @group Advanced driver contracts
 */
export interface Check {
  id: string;
  label: string;
  run(): Promise<CheckResult>;
}

export function failedCheck(id: string, label: string, reason: string, repair: string): Check {
  return { id, label, run: async () => ({ ok: false, reason, repair }) };
}
