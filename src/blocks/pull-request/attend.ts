// Driving the pull request gate by hand. `for await` cannot do it: the gate has
// to be told the ids of the replies the consumer posted, and only `next(ack)`
// carries them back. What lives here is the mechanics — the loop, the ack
// threading, the disposal — so a factory's loop is only its switch.

import type { GateAck, GateWake } from "./gate.ts";

export type Attend<T> = { listen: GateAck | undefined } | { finished: T };

export const listen = (ack?: GateAck): Attend<never> => ({ listen: ack });

export const finished = <T>(value: T): Attend<T> => ({ finished: value });

// The whole loop is inside the try: the gate holds one hook per PR and
// disposes it in its own finally, which only runs if the generator is
// returned. An onWake that throws would otherwise leak a durable PR-scoped
// lock that blocks every later run on that pull request.
export async function attend<T>(
  wakes: AsyncGenerator<GateWake, void, GateAck | undefined>,
  onWake: (wake: GateWake) => Promise<Attend<T>> | Attend<T>,
  describe?: string,
): Promise<T> {
  let ack: GateAck | undefined;
  try {
    for (;;) {
      const next = await wakes.next(ack);
      if (next.done === true) break;
      ack = undefined;
      const outcome = await onWake(next.value);
      if ("finished" in outcome) return outcome.finished;
      ack = outcome.listen;
    }
  } finally {
    await wakes.return();
  }
  throw new Error(
    `the pull request gate${describe === undefined ? "" : ` for ${describe}`} stopped delivering wakes before the PR closed`,
  );
}
