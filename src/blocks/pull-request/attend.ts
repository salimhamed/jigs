// Driving the pull request gate by hand. What lives here is the mechanics —
// the loop, the disposal, and returning a value out of it — so a factory's
// loop is only its switch. The whole loop is inside the try: the gate holds
// one hook per PR and disposes it in its own finally, which only runs if the
// generator is returned. An onWake that throws would otherwise leak a durable
// PR-scoped lock that blocks every later run on that pull request.

import type { GateWake } from "./gate.ts";

export type Attend<T> = { listen: true } | { finished: T };

export const listen = (): Attend<never> => ({ listen: true });

export const finished = <T>(value: T): Attend<T> => ({ finished: value });

export async function attend<T>(
  wakes: AsyncGenerator<GateWake, void, undefined>,
  onWake: (wake: GateWake) => Promise<Attend<T>> | Attend<T>,
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
