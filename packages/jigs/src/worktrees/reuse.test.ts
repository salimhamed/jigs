import { expect, test } from "vitest";
import {
  decideReuse,
  WorktreeNotReusableError,
  WorktreeOwnedError,
} from "./reuse.ts";

const path = "/data/worktrees/acme-abc12345/api/salim-fix";

const cleanDisk = {
  branchMatches: true,
  clean: true,
  diverged: false,
};

test("registered to a live run is a hard error naming the owner", () => {
  expect(() =>
    decideReuse({
      path,
      registration: { ownerRunId: "run_owner", ownerLive: true },
      requestingRunId: "run_new",
      disk: cleanDisk,
    }),
  ).toThrow(WorktreeOwnedError);
  try {
    decideReuse({
      path,
      registration: { ownerRunId: "run_owner", ownerLive: true },
      requestingRunId: "run_new",
      disk: cleanDisk,
    });
  } catch (err) {
    expect(err).toBeInstanceOf(WorktreeOwnedError);
    expect((err as WorktreeOwnedError).owningRunId).toBe("run_owner");
    expect((err as WorktreeOwnedError).message).toContain("run_owner");
  }
});

test("unowned, clean, and ff-safe is reused", () => {
  expect(
    decideReuse({
      path,
      registration: null,
      requestingRunId: "run_new",
      disk: cleanDisk,
    }),
  ).toBe("reuse");
});

test("a terminal owner's clean worktree is reused", () => {
  expect(
    decideReuse({
      path,
      registration: { ownerRunId: "run_done", ownerLive: false },
      requestingRunId: "run_new",
      disk: cleanDisk,
    }),
  ).toBe("reuse");
});

test("unowned but dirty is preserved and errors with guidance", () => {
  const attempt = () =>
    decideReuse({
      path,
      registration: null,
      requestingRunId: "run_new",
      disk: { ...cleanDisk, clean: false },
    });
  expect(attempt).toThrow(WorktreeNotReusableError);
  expect(attempt).toThrow("uncommitted changes");
  expect(attempt).toThrow("git worktree remove");
});

test("unowned but diverged is preserved and errors with guidance", () => {
  const attempt = () =>
    decideReuse({
      path,
      registration: null,
      requestingRunId: "run_new",
      disk: { ...cleanDisk, diverged: true },
    });
  expect(attempt).toThrow(WorktreeNotReusableError);
  expect(attempt).toThrow("diverged");
});

test("a directory holding the wrong branch is preserved and errors", () => {
  const attempt = () =>
    decideReuse({
      path,
      registration: null,
      requestingRunId: "run_new",
      disk: { ...cleanDisk, branchMatches: false },
    });
  expect(attempt).toThrow(WorktreeNotReusableError);
  expect(attempt).toThrow("different branch");
});

test("no worktree on disk goes through three-way resolution", () => {
  expect(
    decideReuse({
      path,
      registration: null,
      requestingRunId: "run_new",
      disk: null,
    }),
  ).toBe("create");
});

test("a registry row whose directory is gone also creates", () => {
  expect(
    decideReuse({
      path,
      registration: { ownerRunId: "run_done", ownerLive: false },
      requestingRunId: "run_new",
      disk: null,
    }),
  ).toBe("create");
});

test("the owning run re-enters its own worktree even when dirty", () => {
  expect(
    decideReuse({
      path,
      registration: { ownerRunId: "run_owner", ownerLive: true },
      requestingRunId: "run_owner",
      disk: { ...cleanDisk, clean: false },
    }),
  ).toBe("reuse");
});
