// The seam between a run being created and whatever wants to know about it.
// The trigger owns run creation and must not learn who is listening: Slack is
// the one subscriber today, and importing it here would put a socket, a model
// and a Postgres table on the path of every `jigs run`.

/** Where a run was started from, when the caller sat somewhere a subscriber
 *  can answer in. Carried through the trigger untouched — nothing on the
 *  trigger path reads it. */
export type RunOrigin = {
  kind: "slack-thread";
  channel: string;
  threadTs: string;
};

export interface RunStarted {
  runId: string;
  pipeline: string;
  triggerId: string;
  /** The run's page on this service's dashboard, the same pointer the trigger
   *  route answers with. */
  logs: string;
  origin?: RunOrigin;
}

export type RunStartedListener = (event: RunStarted) => void;

const listeners = new Set<RunStartedListener>();

/** Subscribe to every run this service creates; the returned function
 *  unsubscribes. */
export function onRunStarted(listener: RunStartedListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Announce a started run. Never throws and never waits: a listener is a
 * bystander, and no run may fail — or be held up — because one of them did.
 */
export function notifyRunStarted(event: RunStarted): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch (err) {
      console.error(
        `[run-events] a listener failed on run ${event.runId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}
