import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { expandHome } from "../paths.ts";
import {
  branchDirname,
  factorySlug,
  worktreeParentDir,
  worktreePath,
} from "./layout.ts";

afterEach(() => vi.unstubAllEnvs());

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

test("worktreePath joins base, factory slug, binding name, branch dirname", () => {
  const p = worktreePath({
    baseDir: "/data/worktrees",
    factoryRoot: "/f/acme",
    bindingName: "api",
    branch: "salim/fix",
  });
  expect(p).toBe(
    path.join("/data/worktrees", factorySlug("/f/acme"), "api", "salim-fix"),
  );
});

test("workspace_dir override wins over the central root", () => {
  const p = worktreePath({
    baseDir: "/data/worktrees",
    factoryRoot: "/f/acme",
    bindingName: "api",
    branch: "salim/fix",
    workspaceDir: "~/wt",
  });
  expect(p).toBe(path.join(expandHome("~/wt"), "salim-fix"));
});

test("worktreeParentDir is the branch-less half of the central path", () => {
  const options = {
    baseDir: "/data/worktrees",
    factoryRoot: "/f/acme",
    bindingName: "api",
  };
  expect(worktreeParentDir(options)).toBe(
    path.join("/data/worktrees", factorySlug("/f/acme"), "api"),
  );
  expect(worktreePath({ ...options, branch: "salim/fix" })).toBe(
    path.join(worktreeParentDir(options), "salim-fix"),
  );
});

test("worktreeParentDir under workspace_dir is the workspace dir itself", () => {
  expect(
    worktreeParentDir({
      baseDir: "/data/worktrees",
      factoryRoot: "/f/acme",
      bindingName: "api",
      workspaceDir: "~/wt",
    }),
  ).toBe(expandHome("~/wt"));
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
      "/xdg-data/jigs/worktrees",
      factorySlug("/f/acme"),
      "api",
      "main",
    ),
  );
});
