import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import {
  bindingDir,
  bindingRepoDir,
  bindingSeedDir,
  branchDirname,
  factorySlug,
  worktreeParentDir,
  worktreePath,
} from "./layout.ts";

afterEach(() => vi.unstubAllEnvs());

const options = {
  baseDir: "/data/bindings",
  factoryRoot: "/f/acme",
  bindingName: "api",
};

test("factorySlug embeds the dirname and is stable for equal paths", () => {
  const slug = factorySlug("/home/x/factories/acme");
  expect(slug).toMatch(/^acme-[0-9a-f]{8}$/);
  expect(factorySlug("/home/x/factories/acme")).toBe(slug);
});

test("factorySlug distinguishes same-named factories at different paths", () => {
  expect(factorySlug("/a/factory")).not.toBe(factorySlug("/b/factory"));
});

test("branchDirname maps slashes to dashes", () => {
  expect(branchDirname("salim/age-308-worktrees")).toBe(
    "salim-age-308-worktrees",
  );
  expect(branchDirname("main")).toBe("main");
});

test("bindingDir joins base, factory slug, and binding name", () => {
  expect(bindingDir(options)).toBe(
    path.join("/data/bindings", factorySlug("/f/acme"), "api"),
  );
});

test("the clone and the seed directory sit inside the binding directory", () => {
  expect(bindingRepoDir(options)).toBe(
    path.join(bindingDir(options), "repo.git"),
  );
  expect(bindingSeedDir(options)).toBe(path.join(bindingDir(options), "seed"));
});

test("worktreeParentDir is the binding's worktrees directory", () => {
  expect(worktreeParentDir(options)).toBe(
    path.join(bindingDir(options), "worktrees"),
  );
});

test("worktreePath joins the binding's worktrees dir and the branch dirname", () => {
  const p = worktreePath({ ...options, branch: "salim/fix" });
  expect(p).toBe(path.join(worktreeParentDir(options), "salim-fix"));
  expect(p).toBe(
    path.join(
      "/data/bindings",
      factorySlug("/f/acme"),
      "api",
      "worktrees",
      "salim-fix",
    ),
  );
});

test("central root defaults to the XDG data home", () => {
  vi.stubEnv("XDG_DATA_HOME", "/xdg-data");
  const p = worktreePath({
    factoryRoot: "/f/acme",
    bindingName: "api",
    branch: "main",
  });
  expect(p).toBe(
    path.join(
      "/xdg-data/jigs/bindings",
      factorySlug("/f/acme"),
      "api",
      "worktrees",
      "main",
    ),
  );
});
