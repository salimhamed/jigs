// How the service wakes a parked run, and what last woke it. Provider events,
// `jigs poke` and the hub's fell-behind pass all wake through `wake`, so the note is written where the wake happens and nothing has to be
// threaded through the workflow to carry it back.
//
// The note is in memory on purpose: a wake is disposable observability, and a
// durable note would put a World write on the path of every provider event.
// A restarted service simply has no note until it wakes the run again.

import { resumeHook } from "workflow/api";
import { HookNotFoundError } from "workflow/errors";

export interface WakeNote {
  /** What resumed the hook: a provider event, a poke, a Slack reply, or the hub falling behind. */
  kind: string;
  at: string;
}

export type WakeOutcome =
  | { outcome: "woken" }
  | { outcome: "gone" }
  | { outcome: "failed"; error: string };

/**
 * Resume the hook behind this token and note the wake for the run that held
 * it. Never throws: a hook nobody holds any more is `gone`, and any other
 * failure is `failed`, so a caller waking a batch carries on.
 */
export async function wake(token: string, source: string): Promise<WakeOutcome> {
  try {
    const hook = await resumeHook(token, undefined);
    recordWake(token, hook.runId, source);
    return { outcome: "woken" };
  } catch (error) {
    if (HookNotFoundError.is(error)) return { outcome: "gone" };
    console.error(
      `[wake] ${source} could not resume ${token.replace(/[\r\n\t]/g, " ")}: ${String(error)}`,
    );
    return { outcome: "failed", error: String(error) };
  }
}

// A pull request outlives the run that opened it, and the next run to work on
// it holds the very same token. Recording the holder is what keeps one run's
// wake from being reported as another's.
const notes = new Map<string, WakeNote & { runId: string }>();

// Bounded because nothing ever removes a token: the oldest note goes, and the
// runs that matter are the ones woken recently.
const MAX_NOTES = 500;

export function recordWake(token: string, runId: string, kind: string, at = new Date()): void {
  notes.delete(token);
  notes.set(token, { runId, kind, at: at.toISOString() });
  if (notes.size > MAX_NOTES) {
    const oldest = notes.keys().next().value;
    if (oldest !== undefined) notes.delete(oldest);
  }
}

/** The note this run is entitled to; a wake another run was sent is not it. */
export function lastWake(token: string, runId: string): WakeNote | undefined {
  const note = notes.get(token);
  if (note === undefined || note.runId !== runId) return undefined;
  return { kind: note.kind, at: note.at };
}

/** Test seam; production gets a fresh map per process. */
export function clearWakes(): void {
  notes.clear();
}
