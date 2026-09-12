import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { git, makeRemoteBackedRepo, makeTmpDir, removeTmpDir } from "../test-fixtures.ts";
import {
  commitsAhead,
  deriveDefaultBranch,
  diffSince,
  probeRemoteAuth,
  pushBranch,
  resolveRemoteUrl,
} from "./git.ts";

let tmp: string;
beforeEach(() => {
  tmp = makeTmpDir();
});
afterEach(() => {
  removeTmpDir(tmp);
});

// A repo whose remotes are the whole point: no commits, no worktree needed.
function repoWithRemotes(name: string, ...remotes: Array<[string, string]>): string {
  const dir = path.join(tmp, name);
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q");
  for (const [remote, url] of remotes) git(dir, "remote", "add", remote, url);
  return dir;
}

test("resolveRemoteUrl prefers origin", async () => {
  const repo = repoWithRemotes(
    "prefers-origin",
    ["origin", "git@github.com:acme/api.git"],
    ["upstream", "git@github.com:other/api.git"],
  );
  expect(await resolveRemoteUrl(repo)).toEqual({
    remote: "origin",
    url: "git@github.com:acme/api.git",
  });
});

test("resolveRemoteUrl falls back to a sole non-origin remote", async () => {
  const repo = repoWithRemotes("sole-remote", ["upstream", "git@github.com:acme/api.git"]);
  expect(await resolveRemoteUrl(repo)).toEqual({
    remote: "upstream",
    url: "git@github.com:acme/api.git",
  });
});

test("resolveRemoteUrl errors with no remote", async () => {
  const repo = repoWithRemotes("no-remote");
  await expect(resolveRemoteUrl(repo)).rejects.toThrow("no git remote");
});

test("resolveRemoteUrl errors on multiple remotes without origin", async () => {
  const repo = repoWithRemotes(
    "two-remotes",
    ["upstream", "git@github.com:a/x.git"],
    ["fork", "git@github.com:b/x.git"],
  );
  await expect(resolveRemoteUrl(repo)).rejects.toThrow("none is origin");
});

test("deriveDefaultBranch reads refs/remotes/origin/HEAD", async () => {
  const repo = repoWithRemotes("with-head", ["origin", "git@github.com:acme/api.git"]);
  git(repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  expect(await deriveDefaultBranch(repo)).toBe("main");
});

test("deriveDefaultBranch returns null when unset", async () => {
  const repo = repoWithRemotes("no-head", ["origin", "git@github.com:acme/api.git"]);
  expect(await deriveDefaultBranch(repo)).toBeNull();
});

// A worktree of the fixture checkout, branched off the default and one commit
// ahead — the shape the review loop pushes from.
function branchWithWork(
  parent: string,
  checkout: string,
  branch: string,
  files: Record<string, string>,
): { tree: string; baseSha: string } {
  const tree = path.join(parent, branch);
  const baseSha = git(checkout, "rev-parse", "HEAD");
  git(checkout, "worktree", "add", "-q", tree, "-b", branch);
  git(tree, "config", "user.name", "jigs-fixture");
  git(tree, "config", "user.email", "fixture@jigs.test");
  for (const [file, content] of Object.entries(files)) {
    writeFileSync(path.join(tree, file), content);
  }
  git(tree, "add", ".");
  git(tree, "commit", "-q", "-m", `work on ${branch}`);
  return { tree, baseSha };
}

test("pushBranch creates the remote branch and is idempotent on a second call", async () => {
  const { remoteDir, checkout } = makeRemoteBackedRepo(tmp);
  const { tree } = branchWithWork(tmp, checkout, "feature", {
    "shipped.txt": "shipped\n",
  });

  await pushBranch(tree, "feature");
  expect(git(checkout, "ls-remote", "--heads", "origin", "feature")).toContain(
    "refs/heads/feature",
  );

  // No new commits: the same push is a no-op rather than a rejection.
  await expect(pushBranch(tree, "feature")).resolves.toBeUndefined();

  writeFileSync(path.join(tree, "more.txt"), "more\n");
  git(tree, "add", ".");
  git(tree, "commit", "-q", "-m", "more work");
  await pushBranch(tree, "feature");
  expect(git(remoteDir, "rev-parse", "refs/heads/feature")).toBe(git(tree, "rev-parse", "HEAD"));
});

test("commitsAhead counts the work on the branch and is 0 on an untouched one", async () => {
  const { checkout } = makeRemoteBackedRepo(tmp);
  const { tree, baseSha } = branchWithWork(tmp, checkout, "feature", {
    "shipped.txt": "shipped\n",
  });
  expect(await commitsAhead(tree, baseSha)).toBe(1);

  const idle = path.join(tmp, "idle");
  git(checkout, "worktree", "add", "-q", idle, "-b", "idle");
  expect(await commitsAhead(idle, baseSha)).toBe(0);
});

test("diffSince returns the branch diff whole", async () => {
  const { checkout } = makeRemoteBackedRepo(tmp);
  const { tree, baseSha } = branchWithWork(tmp, checkout, "feature", {
    "shipped.txt": `${"line\n".repeat(500)}`,
  });

  const full = await diffSince(tree, baseSha);
  expect(full).toContain("+++ b/shipped.txt");
  expect(full).not.toContain("diff truncated");
});

test("a runaway diff is truncated rather than handed to a prompt whole", async () => {
  const { checkout } = makeRemoteBackedRepo(tmp);
  // Past the cap the prompt interpolation can carry, with the marker line the
  // reader is left with.
  const { tree, baseSha } = branchWithWork(tmp, checkout, "feature", {
    "generated.txt": `${"a".repeat(80)}\n`.repeat(4_000),
  });

  const clipped = await diffSince(tree, baseSha);
  expect(clipped.endsWith("\n… (diff truncated)")).toBe(true);
  expect(clipped).toHaveLength(200_000 + "\n… (diff truncated)".length);
});

test("probeRemoteAuth returns null for a reachable remote and stderr for an unreachable one", async () => {
  const { remoteDir } = makeRemoteBackedRepo(tmp);
  expect(await probeRemoteAuth(remoteDir, 10_000)).toBeNull();

  // The regression guard for GIT_TERMINAL_PROMPT=0: an unreachable remote
  // must fail inside the timeout, not hang on a credential prompt.
  const stderr = await probeRemoteAuth(path.join(tmp, "nonexistent.git"), 10_000);
  expect(stderr).not.toBeNull();
  expect(stderr).toContain("nonexistent.git");
}, 20_000);

test("probeRemoteAuth never lets the remote string become a git option", async () => {
  const marker = path.join(tmp, "pwned");
  // Positionally, this is the repository. Parsed as an option it is a command
  // git runs against the trailing `HEAD`.
  const stderr = await probeRemoteAuth(`--upload-pack=touch ${marker}`, 10_000);

  expect(existsSync(marker)).toBe(false);
  expect(stderr).toContain("--upload-pack=");
}, 20_000);
