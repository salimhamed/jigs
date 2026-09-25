import { expect, test } from "vitest";
import { attend, finished, listen } from "./attend.ts";
import type { PullRequestWake } from "./gate.ts";

const red = (headSha: string): PullRequestWake => ({
  kind: "ci-red",
  headSha,
  failing: [],
  mentionLogin: null,
});

function gate(wakes: PullRequestWake[]) {
  const trail: string[] = [];
  async function* deliver(): AsyncGenerator<PullRequestWake, void, undefined> {
    try {
      for (const wake of wakes) yield wake;
      trail.push("ran out");
    } finally {
      trail.push("gate closed");
    }
  }
  return { trail, wakes: deliver() };
}

test("every wake reaches the switch until one finishes the loop", async () => {
  const g = gate([red("sha-1"), red("sha-2"), red("sha-3")]);

  const seen: string[] = [];
  const result = await attend<string>(g.wakes, (wake) => {
    seen.push(wake.kind === "ci-red" ? wake.headSha : wake.kind);
    return seen.length === 3 ? finished("done") : listen();
  });

  expect(result).toBe("done");
  expect(seen).toEqual(["sha-1", "sha-2", "sha-3"]);
});

test("finishing early still returns the gate, so its hook is disposed", async () => {
  const g = gate([red("sha-1"), red("sha-2")]);

  await attend<number>(g.wakes, () => finished(1));

  expect(g.trail).toEqual(["gate closed"]);
});

test("an onWake that throws still returns the gate", async () => {
  const g = gate([red("sha-1")]);

  await expect(
    attend<number>(g.wakes, () => {
      throw new Error("the switch exploded");
    }),
  ).rejects.toThrow("the switch exploded");
  expect(g.trail).toEqual(["gate closed"]);
});

test("a gate that runs out of wakes is an error, not a silent success", async () => {
  const g = gate([red("sha-1")]);

  await expect(attend<number>(g.wakes, () => listen())).rejects.toThrow(
    "stopped delivering wakes before the PR closed",
  );
  expect(g.trail).toEqual(["ran out", "gate closed"]);
});

test("the error names the pull request when the caller described it", async () => {
  const g = gate([]);

  await expect(attend<number>(g.wakes, () => listen(), "acme/api#41")).rejects.toThrow(
    "gate for acme/api#41 stopped delivering",
  );
});
