import type { ChildProcess } from "node:child_process";

/**
 * How one stop attempt on a process group ended. `not-confirmed` means the group was still
 * visible after SIGKILL and the post-kill wait: its members can run no more code, so callers
 * carry on with cleanup. `signal-failed` means a signal could not be delivered for a reason other
 * than the group being gone; the group stays registered so service shutdown tries again.
 */
export type GroupStopOutcome =
  | { kind: "stopped"; pgid: number }
  | { kind: "not-confirmed"; pgid: number }
  | { kind: "signal-failed"; pgid: number; reason: string };

/** Sends a signal the way `process.kill` does. Tests inject a failing one. */
export type Signaller = (pid: number, signal: NodeJS.Signals | 0) => void;

export interface StopTimings {
  graceMs: number;
  postKillMs: number;
  pollMs: number;
}

const TIMINGS: StopTimings = { graceMs: 1_000, postKillMs: 1_000, pollMs: 50 };
const SWEEP_MS = 1_000;

type Tracked = { owner: string; stopping: Promise<GroupStopOutcome> | null };
type Registry = {
  groups: Map<number, Tracked>;
  exitHook: boolean;
  sweep: NodeJS.Timeout | undefined;
};

// Keyed on globalThis because the service and a factory's step bundle can each
// load their own copy of this module, and shutdown must see every live group.
const REGISTRY = Symbol.for("jigs.processGroups");

function registry(): Registry {
  const holder = globalThis as { [REGISTRY]?: Registry };
  holder[REGISTRY] ??= { groups: new Map(), exitHook: false, sweep: undefined };
  return holder[REGISTRY];
}

const defaultSignaller: Signaller = (pid, signal) => {
  process.kill(pid, signal);
};

class SignalFailure extends Error {}

// true when the group exists, false when it is gone; SignalFailure otherwise.
function send(kill: Signaller, pgid: number, signal: NodeJS.Signals | 0): boolean {
  try {
    kill(-pgid, signal);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw new SignalFailure(
      `${signal === 0 ? "probing" : `sending ${signal} to`} process group ${pgid} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref());

async function goneWithin(
  kill: Signaller,
  pgid: number,
  ms: number,
  pollMs: number,
): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (send(kill, pgid, 0)) {
    if (Date.now() >= deadline) return false;
    await sleep(pollMs);
  }
  return true;
}

async function attemptStop(
  kill: Signaller,
  pgid: number,
  timings: StopTimings,
): Promise<GroupStopOutcome> {
  try {
    if (!send(kill, pgid, "SIGTERM")) return { kind: "stopped", pgid };
    if (await goneWithin(kill, pgid, timings.graceMs, timings.pollMs))
      return { kind: "stopped", pgid };
    // Checked just before, so a group that is gone (and whose id could be
    // reused) is never sent SIGKILL.
    if (!send(kill, pgid, "SIGKILL")) return { kind: "stopped", pgid };
    if (await goneWithin(kill, pgid, timings.postKillMs, timings.pollMs))
      return { kind: "stopped", pgid };
    return { kind: "not-confirmed", pgid };
  } catch (error) {
    if (error instanceof SignalFailure)
      return { kind: "signal-failed", pgid, reason: error.message };
    throw error;
  }
}

function report(owner: string, outcome: GroupStopOutcome, timings: StopTimings): void {
  if (outcome.kind === "not-confirmed")
    console.warn(
      `[jigs] ${owner}: process group ${outcome.pgid} was still visible ${timings.postKillMs}ms after SIGKILL; continuing cleanup`,
    );
  if (outcome.kind === "signal-failed")
    console.error(
      `[jigs] ${owner}: could not stop process group ${outcome.pgid}: ${outcome.reason}. It stays registered, so service shutdown tries again; check for surviving processes`,
    );
}

// A group can end without a stop through here, such as a harness that exits
// on its own, or one whose stop failed. Retire it as soon as it is gone, so a
// later stop or shutdown never signals a reused id.
function sweep(state: Registry): void {
  for (const [pgid, tracked] of state.groups) {
    if (tracked.stopping !== null) continue;
    try {
      process.kill(-pgid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") state.groups.delete(pgid);
    }
  }
  if (state.groups.size > 0) return;
  clearInterval(state.sweep);
  state.sweep = undefined;
}

/**
 * Register a process group this process started with `detached: true`, so
 * {@link stopProcessGroups} and process exit reach it. `owner` names it in diagnostics, such as
 * `Pi for run wrun_123`.
 */
export function trackProcessGroup(pgid: number, owner: string): void {
  const state = registry();
  state.groups.set(pgid, { owner, stopping: null });
  state.sweep ??= setInterval(() => sweep(state), SWEEP_MS).unref();
  if (state.exitHook) return;
  state.exitHook = true;
  // A signal or crash that ends this process no longer reaches a private
  // group. `exit` handlers cannot wait, so kill outright.
  process.on("exit", () => {
    for (const pgid of state.groups.keys()) {
      try {
        process.kill(-pgid, "SIGKILL");
      } catch {
        // Gone already, or beyond reach; nothing more can be done at exit.
      }
    }
  });
}

/**
 * Stop a tracked group: SIGTERM, up to a second of grace, SIGKILL, then up to a second more for
 * it to disappear. Concurrent calls share one attempt. The group is retired from the registry
 * unless a signal failed, and a retired or untracked id is never signalled, since the system may
 * have reused it: stopping one reports `stopped` at once.
 */
export function stopProcessGroup(
  pgid: number,
  options: { kill?: Signaller; timings?: StopTimings } = {},
): Promise<GroupStopOutcome> {
  const { groups } = registry();
  const tracked = groups.get(pgid);
  if (tracked === undefined) return Promise.resolve({ kind: "stopped", pgid });
  if (tracked.stopping !== null) return tracked.stopping;
  const timings = options.timings ?? TIMINGS;
  const stopping = attemptStop(options.kill ?? defaultSignaller, pgid, timings).then((outcome) => {
    report(tracked.owner, outcome, timings);
    if (outcome.kind === "signal-failed") tracked.stopping = null;
    else if (groups.get(pgid) === tracked) groups.delete(pgid);
    return outcome;
  });
  tracked.stopping = stopping;
  return stopping;
}

/** Stop every group this process still tracks, as service shutdown does. */
export function stopProcessGroups(): Promise<GroupStopOutcome[]> {
  return Promise.all([...registry().groups.keys()].map((pgid) => stopProcessGroup(pgid)));
}

/** Whether a group is still registered. For tests. */
export function isTrackedProcessGroup(pgid: number): boolean {
  return registry().groups.has(pgid);
}

/** Whether a harness is spawned as the leader of its own process group: everywhere but Windows. */
export const OWN_GROUP = process.platform !== "win32";

/**
 * Track a child spawned with `detached: OWN_GROUP`, and return how to reap it: stop its group, or
 * on Windows SIGTERM the child itself. Every call shares the first attempt.
 */
export function groupReaper(child: ChildProcess, owner: string): () => Promise<void> {
  const pgid = OWN_GROUP ? child.pid : undefined;
  if (pgid !== undefined) trackProcessGroup(pgid, owner);
  let reaping: Promise<void> | undefined;
  return () => {
    if (reaping !== undefined) return reaping;
    if (pgid !== undefined) reaping = stopProcessGroup(pgid).then(() => {});
    else {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      reaping = Promise.resolve();
    }
    return reaping;
  };
}
