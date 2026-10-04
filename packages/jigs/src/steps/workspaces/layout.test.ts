import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { factorySlug } from "../../config/paths.ts";
import {
  bindingFilesDir,
  branchDirname,
  cloneDir,
  cloneRepoDir,
  worktreeParentDir,
  worktreePath,
} from "./layout.ts";

// Every path below hangs off the XDG data home, so the whole file is read
// against one the test names.
const CLONES = "/xdg-data/jigs/clones";

beforeEach(() => vi.stubEnv("XDG_DATA_HOME", "/xdg-data"));
afterEach(() => vi.unstubAllEnvs());

const options = { factoryRoot: "/f/acme", bindingName: "api" };

test("branchDirname maps slashes to dashes", () => {
  expect(branchDirname("salim/age-308-worktrees")).toBe("salim-age-308-worktrees");
  expect(branchDirname("main")).toBe("main");
});

test("cloneDir joins the data home, factory slug, and binding name", () => {
  expect(cloneDir(options)).toBe(path.join(CLONES, factorySlug("/f/acme"), "api"));
});

test("the clone sits inside the clone directory", () => {
  expect(cloneRepoDir(options)).toBe(path.join(cloneDir(options), "repo.git"));
});

test("worktreeParentDir is the binding's worktrees directory", () => {
  expect(worktreeParentDir(options)).toBe(path.join(cloneDir(options), "worktrees"));
});

test("worktreePath joins the binding's worktrees dir and the branch dirname", () => {
  const p = worktreePath({ ...options, branch: "salim/fix" });
  expect(p).toBe(path.join(worktreeParentDir(options), "salim-fix"));
  expect(p).toBe(path.join(CLONES, factorySlug("/f/acme"), "api", "worktrees", "salim-fix"));
});

test("the central root is the XDG data home, wherever it moves", () => {
  vi.stubEnv("XDG_DATA_HOME", "/elsewhere");
  expect(worktreePath({ ...options, branch: "main" })).toBe(
    path.join("/elsewhere/jigs/clones", factorySlug("/f/acme"), "api", "worktrees", "main"),
  );
});

test("bindingFilesDir is the factory repo's bindings folder, not the clone", () => {
  expect(bindingFilesDir("/f/acme", "api")).toBe(path.join("/f/acme", "bindings", "api"));
});
