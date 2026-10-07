import { expect, test, vi } from "vitest";
import { type LiveTurn, liveTurn, registerLiveTurn } from "./live-turns.ts";

const turn = (): LiveTurn => ({ inject: () => true, stop: () => {} });

test("a registered turn is found by its conversation until it unregisters", () => {
  const live = turn();
  const unregister = registerLiveTurn("test:found", live);
  expect(liveTurn("test:found")).toBe(live);
  unregister();
  expect(liveTurn("test:found")).toBeUndefined();
});

test("a conversation with no live turn has none", () => {
  expect(liveTurn("test:none")).toBeUndefined();
});

test("a second live turn on one conversation is a bug", () => {
  const unregister = registerLiveTurn("test:twice", turn());
  try {
    expect(() => registerLiveTurn("test:twice", turn())).toThrow(
      "conversation test:twice already has a live turn",
    );
  } finally {
    unregister();
  }
});

test("unregistering twice leaves a later turn on the same conversation alone", () => {
  const unregister = registerLiveTurn("test:later", turn());
  unregister();
  const later = turn();
  const unregisterLater = registerLiveTurn("test:later", later);
  unregister();
  expect(liveTurn("test:later")).toBe(later);
  unregisterLater();
});

test("the registry is shared by every copy of the module", async () => {
  const live = turn();
  const unregister = registerLiveTurn("test:shared", live);
  try {
    vi.resetModules();
    const copy = await import("./live-turns.ts");
    expect(copy.liveTurn).not.toBe(liveTurn);
    expect(copy.liveTurn("test:shared")).toBe(live);
  } finally {
    unregister();
  }
});
