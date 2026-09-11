import { expect, test } from "vitest";
import { attend, finished, listen } from "./attend.ts";
import type { GateAck, GateWake } from "./gate.ts";

const green = (headSha: string): GateWake => ({ kind: "ci-green", headSha });

function gate(wakes: GateWake[]) {
  const trail: string[] = [];
  const acks: Array<GateAck | undefined> = [];
  async function* deliver(): AsyncGenerator<
    GateWake,
    void,
    GateAck | undefined
  > {
    try {
      for (const wake of wakes) {
        const ack = yield wake;
        acks.push(ack);
      }
      trail.push("ran out");
    } finally {
      trail.push("gate closed");
    }
  }
  return { trail, acks, wakes: deliver() };
}

test("an ack returned from one wake is what the next next() carries", async () => {
  const g = gate([green("sha-1"), green("sha-2"), green("sha-3")]);

  const seen: string[] = [];
  const result = await attend<string>(g.wakes, (wake) => {
    seen.push(wake.kind === "ci-green" ? wake.headSha : wake.kind);
    if (seen.length === 3) return finished("done");
    if (seen.length === 1) return listen({ selfCommentIds: [7] });
    return listen();
  });

  expect(result).toBe("done");
  // The ack rides on the very next next() and no further: an ack is consumed
  // once, never re-sent on the wake after it. The first next() carries none,
  // because a generator discards the value sent into its first resumption.
  expect(g.acks).toEqual([{ selfCommentIds: [7] }, undefined]);
});

test("finishing early still returns the gate, so its hook is disposed", async () => {
  const g = gate([green("sha-1"), green("sha-2")]);

  await attend<number>(g.wakes, () => finished(1));

  expect(g.trail).toEqual(["gate closed"]);
});

test("an onWake that throws still returns the gate", async () => {
  const g = gate([green("sha-1")]);

  await expect(
    attend<number>(g.wakes, () => {
      throw new Error("the switch exploded");
    }),
  ).rejects.toThrow("the switch exploded");
  expect(g.trail).toEqual(["gate closed"]);
});

test("a gate that runs out of wakes is an error, not a silent success", async () => {
  const g = gate([green("sha-1")]);

  await expect(attend<number>(g.wakes, () => listen())).rejects.toThrow(
    "stopped delivering wakes before the PR closed",
  );
  expect(g.trail).toEqual(["ran out", "gate closed"]);
});

test("the error names the pull request when the caller described it", async () => {
  const g = gate([]);

  await expect(
    attend<number>(g.wakes, () => listen(), "acme/api#41"),
  ).rejects.toThrow("gate for acme/api#41 stopped delivering");
});
