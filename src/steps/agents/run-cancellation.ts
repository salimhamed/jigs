import { getWorld } from "workflow/runtime";
import { TERMINAL_RUN_STATUSES } from "../../run-status.ts";

/** How an agent invocation reads its run's persisted status. Tests replace it. */
export interface RunStatusReader {
  /** One authoritative read. Throws when the run cannot be read, including when it is missing. */
  read(runId: string): Promise<string>;
  /**
   * Resolve once the run is terminal or about `timeoutMs` has passed, with the status it saw.
   * It may resolve early with a nonterminal status, and may ignore `signal`.
   */
  waitForTerminal(runId: string, timeoutMs: number, signal: AbortSignal): Promise<string>;
}

/** The step's error once its run was cancelled: fatal, so the SDK records no retry. */
// `fatal` is what the SDK's FatalError.is reads. Extending FatalError would
// need the SDK's value at module load, which factory tests commonly mock away.
export class RunCancelledError extends Error {
  readonly fatal = true;
  constructor(runId: string, options?: { cause?: unknown; beforeStart?: boolean }) {
    super(
      options?.beforeStart
        ? `run ${runId} was cancelled, so jigs did not start its agent`
        : `run ${runId} was cancelled, so jigs stopped its agent`,
    );
    this.name = "RunCancelledError";
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}

/** A live watch on one run, from {@link watchRunCancellation}. */
export interface RunCancellation {
  /** Aborts, with a {@link RunCancelledError}, once the run is seen cancelled. */
  signal: AbortSignal;
  /** The error to throw for `error`: a {@link RunCancelledError} once the run was cancelled. */
  classify(error: unknown): unknown;
  /** Stop watching. Returns at once, even while a status read is still in flight. */
  dispose(): void;
}

const WATCH_MS = 1_000;
const RETRY_MIN_MS = 250;
const RETRY_MAX_MS = 5_000;

export const worldRunStatus: RunStatusReader = {
  read: async (runId) => (await (await getWorld()).runs.get(runId, { resolveData: "none" })).status,
  waitForTerminal: async (runId, timeoutMs, signal) => {
    const { runs } = await getWorld();
    if (runs.waitForTerminalStatus === undefined)
      return (await runs.get(runId, { resolveData: "none" })).status;
    return (await runs.waitForTerminalStatus(runId, { resolveData: "none", timeoutMs, signal }))
      .status;
  },
};

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    timer.unref?.();
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * Read the run's status, refuse to go on if it is cancelled, and watch it until disposed.
 *
 * @remarks
 * A failed first read throws an ordinary error, so the SDK retries the step instead of an agent
 * starting unwatched. That includes a missing run: a resilient first delivery can run its first
 * step before the run row exists.
 */
export async function watchRunCancellation(
  runId: string,
  reader: RunStatusReader = worldRunStatus,
): Promise<RunCancellation> {
  let status: string;
  try {
    status = await reader.read(runId);
  } catch (error) {
    throw new Error(`could not read run ${runId} before starting its agent: ${message(error)}`, {
      cause: error,
    });
  }
  if (status === "cancelled") throw new RunCancelledError(runId, { beforeStart: true });

  const cancelled = new AbortController();
  const disposal = new AbortController();
  const watch = async () => {
    let failures = 0;
    while (!disposal.signal.aborted) {
      const started = Date.now();
      let seen: string;
      try {
        seen = await reader.waitForTerminal(runId, WATCH_MS, disposal.signal);
      } catch (error) {
        if (disposal.signal.aborted) return;
        const wait = Math.min(RETRY_MAX_MS, RETRY_MIN_MS * 2 ** failures);
        failures += 1;
        console.warn(
          `[jigs] run ${runId}: cannot read its status to watch for cancellation (${message(error)}); retrying in ${wait}ms`,
        );
        await delay(wait, disposal.signal);
        continue;
      }
      if (disposal.signal.aborted) return;
      if (failures > 0) console.warn(`[jigs] run ${runId}: watching for cancellation again`);
      failures = 0;
      if (seen === "cancelled") {
        cancelled.abort(new RunCancelledError(runId));
        return;
      }
      if (TERMINAL_RUN_STATUSES.has(seen)) return;
      // A World may answer early with a running status; pace so that is not a busy loop.
      const remaining = WATCH_MS - (Date.now() - started);
      if (remaining > 0) await delay(remaining, disposal.signal);
    }
  };
  if (!TERMINAL_RUN_STATUSES.has(status)) void watch();

  return {
    signal: cancelled.signal,
    classify: (error) =>
      cancelled.signal.aborted && !(error instanceof RunCancelledError)
        ? new RunCancelledError(runId, { cause: error })
        : error,
    dispose: () => disposal.abort(),
  };
}

/** Run `action` with a signal that aborts once the run is cancelled; see {@link watchRunCancellation}. */
export async function withRunCancellation<T>(
  runId: string,
  action: (signal: AbortSignal) => Promise<T>,
  reader: RunStatusReader = worldRunStatus,
): Promise<T> {
  const watch = await watchRunCancellation(runId, reader);
  try {
    return await action(watch.signal);
  } catch (error) {
    throw watch.classify(error);
  } finally {
    watch.dispose();
  }
}
