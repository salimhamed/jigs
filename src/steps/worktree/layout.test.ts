import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  bindingDir,
  bindingRepoDir,
  branchDirname,
  factorySlug,
  worktreeParentDir,
  worktreePath,
} from "./layout.ts";

// Every path below hangs off the XDG data home, so the whole file is read
// against one the test names.
const BINDINGS = "/xdg-data/jigs/bindings";

beforeEach(() => vi.stubEnv("XDG_DATA_HOME", "/xdg-data"));
afterEach(() => vi.unstubAllEnvs());

const options = { factoryRoot: "/f/acme", bindingName: "api" };

test("factorySlug embeds the dirname and is stable for equal paths", () => {
  const slug = factorySlug("/home/x/factories/acme");
  expect(slug).toMatch(/^acme-[0-9a-f]{8}$/);
  expect(factorySlug("/home/x/factories/acme")).toBe(slug);
});

test("factorySlug distinguishes same-named factories at different paths", () => {
  expect(factorySlug("/a/factory")).not.toBe(factorySlug("/b/factory"));
});

test("branchDirname maps slashes to dashes", () => {
  expect(branchDirname("salim/age-308-worktrees")).toBe("salim-age-308-worktrees");
  expect(branchDirname("main")).toBe("main");
});

test("bindingDir joins the data home, factory slug, and binding name", () => {
  expect(bindingDir(options)).toBe(path.join(BINDINGS, factorySlug("/f/acme"), "api"));
});

test("the clone sits inside the binding directory", () => {
  expect(bindingRepoDir(options)).toBe(path.join(bindingDir(options), "repo.git"));
});

test("worktreeParentDir is the binding's worktrees directory", () => {
  expect(worktreeParentDir(options)).toBe(path.join(bindingDir(options), "worktrees"));
});

test("worktreePath joins the binding's worktrees dir and the branch dirname", () => {
  const p = worktreePath({ ...options, branch: "salim/fix" });
  expect(p).toBe(path.join(worktreeParentDir(options), "salim-fix"));
  expect(p).toBe(path.join(BINDINGS, factorySlug("/f/acme"), "api", "worktrees", "salim-fix"));
});

test("the central root is the XDG data home, wherever it moves", () => {
  vi.stubEnv("XDG_DATA_HOME", "/elsewhere");
  expect(worktreePath({ ...options, branch: "main" })).toBe(
    path.join("/elsewhere/jigs/bindings", factorySlug("/f/acme"), "api", "worktrees", "main"),
  );
});
