// The floor under the webhook. GitHub never retries a delivery it failed to
// make, so a run parked on a pull request would wait for a human otherwise.
// Every five minutes the service resumes each held pull-request hook through
// the same path the ingress and `jigs poke` use, and the gate re-reads GitHub
// from scratch: the wake carries nothing, so a nudge and a delivery are the
// same event.

import { resumeHook } from "workflow/api";
import { HookNotFoundError } from "workflow/errors";
import { PR_TOKEN_PREFIX } from "../blocks/pull-requests/gate.ts";
import { listWorldHooks } from "./runs.ts";
import { runsWithActiveStep } from "./stalls.ts";
import { recordWake } from "./wake-note.ts";

/** The detection target for a lost delivery. */
export const NUDGE_INTERVAL_MS = 5 * 60_000;

// Subtracted, never added: the target is a promise, so the jitter only ever
// makes a sweep early. It exists so restarted services do not all sweep on the
// same second.
const NUDGE_JITTER_MS = 30_000;

export interface NudgeDeps {
  hooks?: () => Promise<Array<{ runId: string; token: string }>>;
  /** Which of these runs is mid-turn. */
  busyRuns?: (runIds: string[]) => Promise<string[]>;
  resume?: (token: string) => Promise<unknown>;
  log?: (line: string) => void;
  warn?: (line: string) => void;
  random?: () => number;
  /** Schedules one run of the sweep and returns its canceller. */
  setTimer?: (fire: () => void, ms: number) => () => void;
}

export interface NudgeReport {
  held: number;
  nudged: number;
  busy: number;
  /** Hooks whose run moved on between the listing and the resume. */
  gone: number;
  /** Resumes that failed for any other reason; each one is warned about. */
  failed: number;
}

export function nudgeDelay(random: () => number = Math.random): number {
  return NUDGE_INTERVAL_MS - Math.floor(random() * NUDGE_JITTER_MS);
}

/**
 * One sweep: resume every held `github:pr:` hook whose run is actually parked.
 * A run mid-turn is skipped, because `resumeHook` neither coalesces nor drops
 * a resume — it appends an event and queues a replay per call, so nudging a
 * busy run buys nothing and grows its event log.
 */
export async function nudgePullRequests(deps: NudgeDeps = {}): Promise<NudgeReport> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const warn = deps.warn ?? ((line: string) => console.error(line));
  const report: NudgeReport = { held: 0, nudged: 0, busy: 0, gone: 0, failed: 0 };
  try {
    const held = (await (deps.hooks ?? listWorldHooks)()).filter((hook) =>
      hook.token.startsWith(PR_TOKEN_PREFIX),
    );
    report.held = held.length;
    if (held.length === 0) {
      log("[nudge] pull requests: none held");
      return report;
    }
    const busy = new Set(
      await (deps.busyRuns ?? runsWithActiveStep)([...new Set(held.map((hook) => hook.runId))]),
    );
    const resume = deps.resume ?? ((token: string) => resumeHook(token, undefined));
    for (const hook of held) {
      if (busy.has(hook.runId)) {
        report.busy += 1;
        continue;
      }
      try {
        await resume(hook.token);
        recordWake(hook.token, hook.runId, "nudge sweep");
        report.nudged += 1;
      } catch (error) {
        // A hook disposed between the listing and the resume is a report: its
        // run has moved on. Anything else is this pull request losing its
        // floor, and nothing else would say so.
        if (HookNotFoundError.is(error)) {
          report.gone += 1;
        } else {
          report.failed += 1;
          warn(`[nudge] could not resume ${hook.token}: ${String(error)}`);
        }
      }
    }
    log(
      `[nudge] pull requests: ${report.held} held, ${report.nudged} nudged, ${report.busy} mid-turn, ${report.gone} gone, ${report.failed} failed`,
    );
    return report;
  } catch (error) {
    // Visible: while this is failing, a lost delivery costs the whole wait
    // again, and nothing else in the service says so.
    warn(
      `[nudge] pull request sweep failed — a lost webhook will not be recovered until it succeeds: ${String(error)}`,
    );
    return report;
  }
}

/** Sweeps on a repeating timer until stopped. One sweep at a time. */
export function startPullRequestNudge(deps: NudgeDeps = {}): { stop: () => void } {
  const setTimer =
    deps.setTimer ??
    ((fire: () => void, ms: number) => {
      const timer = setTimeout(fire, ms);
      // The sweep must never be the reason the process stays up.
      timer.unref?.();
      return () => clearTimeout(timer);
    });
  let cancel: (() => void) | null = null;
  let stopped = false;
  const schedule = () => {
    if (stopped) return;
    cancel = setTimer(() => {
      void nudgePullRequests(deps).then(schedule);
    }, nudgeDelay(deps.random));
  };
  schedule();
  return {
    stop: () => {
      stopped = true;
      cancel?.();
    },
  };
}
