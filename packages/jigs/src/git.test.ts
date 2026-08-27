import { mkdirSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  assertCheckoutRoot,
  checkoutRoot,
  deriveDefaultBranch,
  probeRemoteAuth,
  resolveRemoteUrl,
} from "./git.ts";
import {
  git,
  makeRemoteBackedRepo,
  makeTargetRepo,
  makeTmpDir,
  removeTmpDir,
} from "./test-fixtures.ts";

let tmp: string;
beforeEach(() => {
  tmp = makeTmpDir();
});
afterEach(() => {
  removeTmpDir(tmp);
});

test("assertCheckoutRoot accepts a checkout root", async () => {
  const repo = makeTargetRepo(tmp);
  await expect(assertCheckoutRoot(repo)).resolves.toBeUndefined();
});

test("assertCheckoutRoot rejects a plain directory", async () => {
  const dir = path.join(tmp, "plain");
  mkdirSync(dir);
  await expect(assertCheckoutRoot(dir)).rejects.toThrow("not a git checkout");
});

test("assertCheckoutRoot rejects a subdirectory of a checkout", async () => {
  const repo = makeTargetRepo(tmp);
  const sub = path.join(repo, "src");
  mkdirSync(sub);
  await expect(assertCheckoutRoot(sub)).rejects.toThrow("not its root");
});

test("checkoutRoot returns null outside a repo", async () => {
  expect(await checkoutRoot(tmp)).toBeNull();
});

test("resolveRemoteUrl prefers origin", async () => {
  const repo = makeTargetRepo(tmp, {
    remoteUrl: "git@github.com:acme/api.git",
  });
  git(repo, "remote", "add", "upstream", "git@github.com:other/api.git");
  expect(await resolveRemoteUrl(repo)).toEqual({
    remote: "origin",
    url: "git@github.com:acme/api.git",
  });
});

test("resolveRemoteUrl falls back to a sole non-origin remote", async () => {
  const repo = makeTargetRepo(tmp, { remoteUrl: null });
  git(repo, "remote", "add", "upstream", "git@github.com:acme/api.git");
  expect(await resolveRemoteUrl(repo)).toEqual({
    remote: "upstream",
    url: "git@github.com:acme/api.git",
  });
});

test("resolveRemoteUrl errors with no remote", async () => {
  const repo = makeTargetRepo(tmp, { remoteUrl: null });
  await expect(resolveRemoteUrl(repo)).rejects.toThrow("no git remote");
});

test("resolveRemoteUrl errors on multiple remotes without origin", async () => {
  const repo = makeTargetRepo(tmp, { remoteUrl: null });
  git(repo, "remote", "add", "upstream", "git@github.com:a/x.git");
  git(repo, "remote", "add", "fork", "git@github.com:b/x.git");
  await expect(resolveRemoteUrl(repo)).rejects.toThrow("none is origin");
});

test("deriveDefaultBranch reads refs/remotes/origin/HEAD", async () => {
  const repo = makeTargetRepo(tmp, { defaultBranch: "main" });
  expect(await deriveDefaultBranch(repo)).toBe("main");
});

test("deriveDefaultBranch returns null when unset", async () => {
  const repo = makeTargetRepo(tmp);
  expect(await deriveDefaultBranch(repo)).toBeNull();
});

test("probeRemoteAuth returns null for a reachable remote and stderr for an unreachable one", async () => {
  const { remoteDir } = makeRemoteBackedRepo(tmp);
  expect(await probeRemoteAuth(remoteDir)).toBeNull();

  // The regression guard for GIT_TERMINAL_PROMPT=0: an unreachable remote
  // must fail inside the timeout, not hang on a credential prompt.
  const stderr = await probeRemoteAuth(
    path.join(tmp, "nonexistent.git"),
    10_000,
  );
  expect(stderr).not.toBeNull();
  expect(stderr).toContain("nonexistent.git");
}, 20_000);
