// What last woke a parked run. The service is the only thing that wakes one —
// the ingress, `jigs poke` and the nudge sweep all resume hooks here — so the
// note is written where the wake happens and nothing has to be threaded
// through the workflow to carry it back.
//
// In memory on purpose: a wake is disposable observability, and a durable note
// would put a World write on the ingress path for every delivery. A restarted
// service simply has no note until it wakes the run again, which the nudge
// sweep does within its interval.

import { getHookByToken } from "workflow/api";

export interface WakeNote {
  /** What resumed the hook: a provider event, a poke, or the nudge sweep. */
  kind: string;
  at: string;
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

/**
 * Record the wake for whichever run holds this hook. Never throws and never
 * blocks the wake itself: a token nobody holds, or a World that cannot be
 * asked, leaves no note.
 */
export async function noteWake(token: string, kind: string): Promise<void> {
  const runId = await getHookByToken(token).then(
    (hook) => hook.runId,
    () => null,
  );
  if (runId !== null) recordWake(token, runId, kind);
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
