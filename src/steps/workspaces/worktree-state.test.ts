import { expect, test } from "vitest";
import { classifyWorktreeState, type WorktreeStateInput } from "./worktree-state.ts";

const input = (overrides: Partial<WorktreeStateInput> = {}): WorktreeStateInput => ({
  path: "/managed/tree",
  branch: "feature",
  ownerRunId: "wrun_owner",
  ownerTerminal: true,
  state: "active",
  onDisk: true,
  dirty: false,
  ...overrides,
});

test("worktree status keeps active, dirty and provisioning evidence visible", () => {
  expect(classifyWorktreeState(input({ ownerTerminal: false })).state).toBe("held");
  expect(classifyWorktreeState(input({ dirty: true }))).toMatchObject({
    state: "abandoned-dirty",
    eligible: false,
  });
  expect(classifyWorktreeState(input({ state: "provision-failed" }))).toMatchObject({
    state: "provision-failed",
    eligible: false,
  });
  expect(classifyWorktreeState(input({ onDisk: false }))).toMatchObject({
    state: "missing",
    eligible: true,
  });
});
