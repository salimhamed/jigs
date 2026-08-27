import { expect, test } from "vitest";
import { classifySweep, type SweepInput } from "./sweep.ts";

function input(overrides: Partial<SweepInput> = {}): SweepInput {
  return {
    path: "/data/worktrees/acme/api/feat",
    branch: "feat",
    ownerRunId: "run_a",
    ownerTerminal: true,
    keep: false,
    state: "active",
    onDisk: true,
    dirty: false,
    registered: true,
    ...overrides,
  };
}

test("a non-terminal owner holds its worktree", () => {
  const entry = classifySweep(input({ ownerTerminal: false }));
  expect(entry.state).toBe("held");
  expect(entry.eligible).toBe(false);
});

test("a suspended run reads as running and is therefore held", () => {
  // The SDK has no `suspended` status — the join sees a non-terminal owner.
  expect(
    classifySweep(input({ ownerTerminal: false, dirty: true })).state,
  ).toBe("held");
});

test("keep: true is never eligible, even for a terminal owner", () => {
  const entry = classifySweep(input({ keep: true }));
  expect(entry.state).toBe("kept");
  expect(entry.eligible).toBe(false);
});

test("a terminal owner with a clean tree is abandoned and eligible", () => {
  const entry = classifySweep(input());
  expect(entry.state).toBe("abandoned");
  expect(entry.eligible).toBe(true);
  expect(entry.requiresForce).toBe(false);
  expect(entry.ownerRunId).toBe("run_a");
});

test("a terminal owner with a dirty tree is abandoned-dirty and needs force", () => {
  const entry = classifySweep(input({ dirty: true }));
  expect(entry.state).toBe("abandoned-dirty");
  expect(entry.eligible).toBe(true);
  expect(entry.requiresForce).toBe(true);
});

test("a half-provisioned tree is kept for diagnosis until force", () => {
  const entry = classifySweep(input({ state: "provision-failed" }));
  expect(entry.state).toBe("provision-failed");
  expect(entry.requiresForce).toBe(true);
});

test("keep: true wins over provision-failed", () => {
  expect(
    classifySweep(input({ state: "provision-failed", keep: true })).state,
  ).toBe("kept");
});

test("a registered path missing from disk is a stale row", () => {
  const entry = classifySweep(input({ onDisk: false }));
  expect(entry.state).toBe("missing");
  expect(entry.eligible).toBe(true);
  expect(entry.requiresForce).toBe(false);
});

test("a directory with no registry row is unregistered", () => {
  const entry = classifySweep(
    input({ registered: false, ownerRunId: null, ownerTerminal: null }),
  );
  expect(entry.state).toBe("unregistered");
  expect(entry.eligible).toBe(true);
  expect(entry.requiresForce).toBe(false);
  expect(entry.ownerRunId).toBeUndefined();
});

test("a dirty unregistered directory needs force", () => {
  const entry = classifySweep(
    input({
      registered: false,
      ownerRunId: null,
      ownerTerminal: null,
      dirty: true,
    }),
  );
  expect(entry.state).toBe("unregistered");
  expect(entry.requiresForce).toBe(true);
});
