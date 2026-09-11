import { expect, test } from "vitest";
import { assertReusable, WorktreeNotReusableError } from "./reuse.ts";

const path = "/data/worktrees/acme-abc12345/api/salim-fix";

const cleanDisk = {
  branchMatches: true,
  clean: true,
  diverged: false,
};

test("unowned, clean, and ff-safe is reusable", () => {
  expect(() =>
    assertReusable({ path, sameOwner: false, disk: cleanDisk }),
  ).not.toThrow();
});

test("unowned but dirty is preserved and errors with guidance", () => {
  const attempt = () =>
    assertReusable({
      path,
      sameOwner: false,
      disk: { ...cleanDisk, clean: false },
    });
  expect(attempt).toThrow(WorktreeNotReusableError);
  expect(attempt).toThrow("uncommitted changes");
  expect(attempt).toThrow("git worktree remove");
});

test("unowned but diverged is preserved and errors with guidance", () => {
  const attempt = () =>
    assertReusable({
      path,
      sameOwner: false,
      disk: { ...cleanDisk, diverged: true },
    });
  expect(attempt).toThrow(WorktreeNotReusableError);
  expect(attempt).toThrow("diverged");
});

test("a directory holding the wrong branch is preserved and errors", () => {
  const attempt = () =>
    assertReusable({
      path,
      sameOwner: false,
      disk: { ...cleanDisk, branchMatches: false },
    });
  expect(attempt).toThrow(WorktreeNotReusableError);
  expect(attempt).toThrow("different branch");
});

test("the owning run re-enters its own worktree even when dirty", () => {
  expect(() =>
    assertReusable({
      path,
      sameOwner: true,
      disk: { ...cleanDisk, clean: false, diverged: true },
    }),
  ).not.toThrow();
});

test("the owning run still cannot re-enter a directory holding another branch", () => {
  expect(() =>
    assertReusable({
      path,
      sameOwner: true,
      disk: { ...cleanDisk, branchMatches: false },
    }),
  ).toThrow(WorktreeNotReusableError);
});
