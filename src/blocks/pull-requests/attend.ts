import type { PullRequestWake } from "./gate.ts";

/** Tells {@link attend} to wait for another wake or finish with a value. */
export type Attend<T> =
  | {
      /** Continue listening for pull request activity. */
      listen: true;
    }
  | {
      /** Stop listening and return this value. */
      finished: T;
    };

/** Keep attending to pull request activity. */
export const listen = (): Attend<never> => ({ listen: true });

/** Finish attending and return a value from the loop. */
export const finished = <T>(value: T): Attend<T> => ({ finished: value });

/**
 * Consume pull request wakes until the handler finishes with a value.
 *
 * @remarks
 * The gate is always closed when the handler returns or throws, which releases its pull request
 * lock. If the gate ends before the pull request closes, this function throws.
 */
export async function attend<T>(
  wakes: AsyncGenerator<PullRequestWake, void, undefined>,
  onWake: (wake: PullRequestWake) => Promise<Attend<T>> | Attend<T>,
  describe?: string,
): Promise<T> {
  try {
    for (;;) {
      const next = await wakes.next();
      if (next.done === true) break;
      const outcome = await onWake(next.value);
      if ("finished" in outcome) return outcome.finished;
    }
  } finally {
    await wakes.return();
  }
  throw new Error(
    `the pull request gate${describe === undefined ? "" : ` for ${describe}`} stopped delivering wakes before the PR closed`,
  );
}
