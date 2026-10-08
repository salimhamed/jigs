// Waking every waiting run at once, for when the hub says it dropped provider
// events this factory never received. Each held hook is resumed through the
// same `wake` provider events and `jigs poke` use, and the woken routine
// re-reads its provider from scratch: the wake carries nothing, so it stands in
// for whatever event was lost.

import { isOwnershipKind, parseHookToken } from "../workflow/hook-tokens.ts";
import { listWorldHooks, runsWithActiveStep } from "./runs.ts";
import { wake } from "./wake.ts";

type HeldHook = { runId: string; token: string };

/** The held hooks that a wake would actually reach a waiting run through. */
function waitingOn(hooks: HeldHook[]): HeldHook[] {
  // The hub stands in only for providers jigs mints tokens for, so a token it
  // did not mint is left to `jigs poke`.
  return hooks.filter((hook) => {
    const kind = parseHookToken(hook.token)?.kind;
    return kind !== undefined && !isOwnershipKind(kind);
  });
}

export interface WakeWaitingDeps {
  hooks?: () => Promise<HeldHook[]>;
  /** Which of these runs is mid-turn. */
  busyRuns?: (runIds: string[]) => Promise<string[]>;
  log?: (line: string) => void;
  warn?: (line: string) => void;
}

export interface WakeWaitingReport {
  held: number;
  woken: number;
  busy: number;
  /** Hooks whose run moved on between the listing and the resume. */
  gone: number;
  /** Wakes that failed for any other reason; `wake` logs each one. */
  failed: number;
}

/**
 * Resume every held hook whose run is actually parked on it. A run mid-turn is
 * skipped, because `resumeHook` neither coalesces nor drops a resume — it
 * appends an event and queues a replay per call, so waking a busy run buys
 * nothing and grows its event log.
 */
export async function wakeAllWaitingRuns(deps: WakeWaitingDeps = {}): Promise<WakeWaitingReport> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const warn = deps.warn ?? ((line: string) => console.error(line));
  const report: WakeWaitingReport = { held: 0, woken: 0, busy: 0, gone: 0, failed: 0 };
  try {
    const held = waitingOn(await (deps.hooks ?? listWorldHooks)());
    report.held = held.length;
    const runIds = [...new Set(held.map((hook) => hook.runId))];
    const busy = new Set(
      runIds.length === 0 ? [] : await (deps.busyRuns ?? runsWithActiveStep)(runIds),
    );
    for (const hook of held) {
      if (busy.has(hook.runId)) {
        report.busy += 1;
        continue;
      }
      const { outcome } = await wake(hook.token, "hub fell behind");
      if (outcome === "woken") report.woken += 1;
      else report[outcome] += 1;
    }
    log(
      `[hub] waiting runs: ${report.held} held, ${report.woken} woken, ${report.busy} mid-turn, ${report.gone} gone, ${report.failed} failed`,
    );
    return report;
  } catch (error) {
    warn(
      `[hub] could not wake the waiting runs; each re-reads its provider only when next woken: ${String(error)}`,
    );
    return report;
  }
}
