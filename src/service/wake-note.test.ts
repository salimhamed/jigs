import { beforeEach, expect, test } from "vitest";
import { clearWakes, lastWake, recordWake } from "./wake-note.ts";

const TOKEN = "github:pr:acme/api#41";
const RUN_A = "wrun_01K3ANBZ4TQ8W9YV6H2E5C7DKM";
const RUN_B = "wrun_01K3ANC1P0R4S6TXZ8B3F5G7HJ";

beforeEach(clearWakes);

test("a wake is readable by the run it was sent to", () => {
  recordWake(TOKEN, RUN_A, "github pull_request", new Date("2026-09-16T10:00:00Z"));
  expect(lastWake(TOKEN, RUN_A)).toEqual({
    kind: "github pull_request",
    at: "2026-09-16T10:00:00.000Z",
  });
});

// One pull request outlives the run that opened it: the next run to work on it
// holds the same token, and must not read the previous run's wake as its own.
test("the next run to hold a pull request starts with no wake", () => {
  recordWake(TOKEN, RUN_A, "nudge sweep");
  expect(lastWake(TOKEN, RUN_B)).toBeUndefined();

  recordWake(TOKEN, RUN_B, "poke");
  expect(lastWake(TOKEN, RUN_B)?.kind).toBe("poke");
  expect(lastWake(TOKEN, RUN_A)).toBeUndefined();
});

test("only the most recent wakes are kept", () => {
  for (let index = 0; index < 600; index += 1)
    recordWake(`github:pr:acme/api#${index}`, RUN_A, "p");
  expect(lastWake("github:pr:acme/api#0", RUN_A)).toBeUndefined();
  expect(lastWake("github:pr:acme/api#599", RUN_A)?.kind).toBe("p");
});
