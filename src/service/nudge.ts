// How a parked run hears from its provider when no webhook tells it. On a
// timer per provider, the service resumes each held hook through the same path
// the ingress and `jigs poke` use, and the woken routine re-reads the provider
// from scratch: the wake carries nothing, so a nudge and a delivery are the
// same event. With webhooks on, this is the floor under a lost delivery —
// GitHub never retries one it failed to make.

import { resumeHook } from "workflow/api";
import { HookNotFoundError } from "workflow/errors";
import type { WebhookProvider } from "../config/factory-config.ts";
import { TICKET_TOKEN_PREFIX } from "../workflow/linear/claim.ts";
import { NEEDS_HUMAN_TOKEN_PREFIX } from "../workflow/linear/halt-for-human.ts";
import { PULL_REQUEST_TOKEN_PREFIX } from "../workflow/pull-requests/pull-request.ts";
import { listWorldHooks } from "./runs.ts";
import { runsWithActiveStep } from "./stalls.ts";
import { recordWake } from "./wake-note.ts";

// Subtracted, never added: the interval is a promise, so the jitter only ever
// makes a sweep early. It exists so restarted services do not all sweep on the
// same second.
const NUDGE_JITTER_FRACTION = 0.1;

type HeldHook = { runId: string; token: string };

interface Subject {
  label: string;
  select: (hooks: HeldHook[]) => HeldHook[];
}

const SUBJECTS: Record<WebhookProvider, Subject> = {
  github: {
    label: "pull requests",
    select: (hooks) => hooks.filter((hook) => hook.token.startsWith(PULL_REQUEST_TOKEN_PREFIX)),
  },
  linear: {
    label: "tickets",
    // A ticket claim is held for the run's whole life, but only a run halted
    // on a human is waiting on it. Waking the claim of a run parked anywhere
    // else would queue a replay and a stale hint on every sweep.
    select: (hooks) => {
      const halted = new Set(
        hooks
          .filter((hook) => hook.token.startsWith(NEEDS_HUMAN_TOKEN_PREFIX))
          .map((hook) => haltKey(hook.runId, hook.token.slice(NEEDS_HUMAN_TOKEN_PREFIX.length))),
      );
      return hooks.filter(
        (hook) =>
          hook.token.startsWith(TICKET_TOKEN_PREFIX) &&
          halted.has(haltKey(hook.runId, hook.token.slice(TICKET_TOKEN_PREFIX.length))),
      );
    },
  },
};

// Both tokens lead with the issue UUID; the halt marker's comment id follows it.
function haltKey(runId: string, rest: string): string {
  return `${runId} ${rest.split(":")[0]}`;
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
  provider: WebhookProvider,
  deps: NudgeDeps = {},
): Promise<NudgeReport> {
  const { label, select } = SUBJECTS[provider];
  const log = deps.log ?? ((line: string) => console.log(line));
  const warn = deps.warn ?? ((line: string) => console.error(line));
  const report: NudgeReport = { held: 0, nudged: 0, busy: 0, gone: 0, failed: 0 };
  try {
    const held = select(await (deps.hooks ?? listWorldHooks)());
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
  intervalSeconds: Record<WebhookProvider, number>,
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
  const cancels = new Map<WebhookProvider, () => void>();
  let stopped = false;
  const schedule = (provider: WebhookProvider) => {
    if (stopped) return;
    const fire = () => {
      void nudgeProvider(provider, deps).then(() => schedule(provider));
    };
    cancels.set(provider, setTimer(fire, nudgeDelay(intervalSeconds[provider], deps.random)));
  };
  schedule("github");
  schedule("linear");
  return {
    stop: () => {
      stopped = true;
      for (const cancel of cancels.values()) cancel();
    },
  };
}
