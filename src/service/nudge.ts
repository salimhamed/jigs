// How a parked run hears from its provider when no webhook tells it. On a
// timer per provider, the service resumes each held hook through the same path
// the ingress and `jigs poke` use, and the woken routine re-reads the provider
// from scratch: the wake carries nothing, so a nudge and a delivery are the
// same event. With webhooks on, this is the floor under a lost delivery —
// GitHub never retries one it failed to make.

import { resumeHook } from "workflow/api";
import { HookNotFoundError } from "workflow/errors";
import { parseHookToken } from "../workflow/hook-tokens.ts";
import type { Provider } from "../workflow/providers.ts";
import { listWorldHooks, runsWithActiveStep } from "./runs.ts";
import { recordWake } from "./wake-note.ts";

// Subtracted, never added: the interval is a promise, so the jitter only ever
// makes a sweep early. It exists so restarted services do not all sweep on the
// same second.
const NUDGE_JITTER_FRACTION = 0.1;

type HeldHook = { runId: string; token: string };

const LABELS: Record<Provider, string> = {
  github: "pull requests",
  linear: "tickets",
  // No run parks on an incident yet; PagerDuty polls only for its trigger.
  pagerduty: "PagerDuty incidents",
  slack: "Slack threads",
};

/** The held hooks of one provider that a wake would actually reach a waiting run through. */
function waitingOn(provider: Provider, hooks: HeldHook[]): HeldHook[] {
  const parsed = hooks.map((hook) => ({ hook, token: parseHookToken(hook.token) }));
  const halted = new Set(
    parsed.flatMap(({ hook, token }) =>
      token?.kind === "needs-human" && token.halt !== null
        ? [`${hook.runId} ${token.halt.issueId}`]
        : [],
    ),
  );
  return parsed
    .filter(({ hook, token }) => {
      if (token?.provider !== provider) return false;
      switch (token.kind) {
        // Nothing resumes the marker; the reply lands on the claim beside it.
        case "needs-human":
          return false;
        // A ticket claim is held for the run's whole life, but only a run halted
        // on a human is waiting on it. Waking the claim of a run parked anywhere
        // else would queue a replay and a stale hint on every sweep.
        case "ticket-claim":
          return halted.has(`${hook.runId} ${token.issueId}`);
        default:
          return true;
      }
    })
    .map(({ hook }) => hook);
}

export interface NudgeDeps {
  hooks?: () => Promise<HeldHook[]>;
  /** Which of these runs is mid-turn. */
  busyRuns?: (runIds: string[]) => Promise<string[]>;
  resume?: (token: string) => Promise<unknown>;
  log?: (line: string) => void;
  warn?: (line: string) => void;
  random?: () => number;
  /** Schedules one run of a sweep and returns its canceller. */
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

/** Milliseconds until the next sweep: the interval, less up to a tenth of it. */
export function nudgeDelay(intervalSeconds: number, random: () => number = Math.random): number {
  const intervalMs = intervalSeconds * 1000;
  return intervalMs - Math.floor(random() * intervalMs * NUDGE_JITTER_FRACTION);
}

/**
 * One sweep: resume every held hook of one provider whose run is actually
 * parked on it. A run mid-turn is skipped, because `resumeHook` neither
 * coalesces nor drops a resume — it appends an event and queues a replay per
 * call, so nudging a busy run buys nothing and grows its event log.
 */
export async function nudgeProvider(
  provider: Provider,
  deps: NudgeDeps = {},
): Promise<NudgeReport> {
  const label = LABELS[provider];
  const log = deps.log ?? ((line: string) => console.log(line));
  const warn = deps.warn ?? ((line: string) => console.error(line));
  const report: NudgeReport = { held: 0, nudged: 0, busy: 0, gone: 0, failed: 0 };
  try {
    const held = waitingOn(provider, await (deps.hooks ?? listWorldHooks)());
    report.held = held.length;
    if (held.length === 0) {
      log(`[nudge] ${label}: none held`);
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
        // run has moved on. Anything else is this run losing its wake, and
        // nothing else would say so.
        if (HookNotFoundError.is(error)) {
          report.gone += 1;
        } else {
          report.failed += 1;
          warn(`[nudge] could not resume ${hook.token}: ${String(error)}`);
        }
      }
    }
    log(
      `[nudge] ${label}: ${report.held} held, ${report.nudged} nudged, ${report.busy} mid-turn, ${report.gone} gone, ${report.failed} failed`,
    );
    return report;
  } catch (error) {
    // Visible: while this is failing, a parked run waits on a webhook that may
    // never come, and nothing else in the service says so.
    warn(
      `[nudge] ${label} sweep failed — parked runs will not be re-read until it succeeds: ${String(error)}`,
    );
    return report;
  }
}

/** Sweep each provider on its own repeating timer until stopped, one sweep per provider at a time. */
export function startNudges(
  intervalSeconds: Record<Provider, number>,
  deps: NudgeDeps = {},
): { stop: () => void } {
  const setTimer =
    deps.setTimer ??
    ((fire: () => void, ms: number) => {
      const timer = setTimeout(fire, ms);
      // The sweep must never be the reason the process stays up.
      timer.unref?.();
      return () => clearTimeout(timer);
    });
  const cancels = new Map<Provider, () => void>();
  let stopped = false;
  const schedule = (provider: Provider) => {
    if (stopped) return;
    const fire = () => {
      void nudgeProvider(provider, deps).then(() => schedule(provider));
    };
    cancels.set(provider, setTimer(fire, nudgeDelay(intervalSeconds[provider], deps.random)));
  };
  for (const provider of Object.keys(LABELS) as Provider[]) schedule(provider);
  return {
    stop: () => {
      stopped = true;
      for (const cancel of cancels.values()) cancel();
    },
  };
}
