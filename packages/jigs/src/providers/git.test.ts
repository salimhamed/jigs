import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { git, makeRemoteBackedRepo, makeTmpDir, removeTmpDir } from "../test-fixtures.ts";
import {
  commitsAhead,
  deriveDefaultBranch,
  diffSince,
  probeRemoteAuth,
  pushBranch,
  remoteGit,
  scrubCredentials,
} from "./git.ts";
import { githubAuthFor } from "./github-auth.ts";

vi.mock("./github-auth.ts", () => ({
  githubAuthFor: vi.fn(() => ({ bearer: async () => "ghs_secret_value" })),
}));

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

test("pushBranch creates the remote branch, says so, and is idempotent on a second call", async () => {
  const { remoteDir, checkout } = makeRemoteBackedRepo(tmp);
  const { tree } = branchWithWork(tmp, checkout, "feature", {
    "shipped.txt": "shipped\n",
  });

  expect(await pushBranch(tree, "feature")).toEqual({ created: true });
  expect(git(checkout, "ls-remote", "--heads", "origin", "feature")).toContain(
    "refs/heads/feature",
  );

  // No new commits: the same push is a no-op rather than a rejection.
  await expect(pushBranch(tree, "feature")).resolves.toEqual({ created: false });

  writeFileSync(path.join(tree, "more.txt"), "more\n");
  git(tree, "add", ".");
  git(tree, "commit", "-q", "-m", "more work");
  expect(await pushBranch(tree, "feature")).toEqual({ created: false });
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
  expect(await probeRemoteAuth(remoteDir, "ghs_token", 10_000)).toBeNull();

  // The regression guard for GIT_TERMINAL_PROMPT=0: an unreachable remote
  // must fail inside the timeout, not hang on a credential prompt.
  const stderr = await probeRemoteAuth(path.join(tmp, "nonexistent.git"), "ghs_token", 10_000);
  expect(stderr).not.toBeNull();
  expect(stderr).toContain("nonexistent.git");
}, 20_000);

test("remoteGit sends the clone's installation token to GitHub without writing it anywhere", async () => {
  const { checkout } = makeRemoteBackedRepo(tmp);
  const header = await remoteGit(
    ["config", "--get-urlmatch", "http.extraheader", "https://github.com/acme/api.git"],
    checkout,
  );

  expect(githubAuthFor).toHaveBeenCalledWith("github-acme");
  expect(header).toBe(
    `Authorization: Basic ${Buffer.from("x-access-token:ghs_secret_value").toString("base64")}`,
  );
  expect(git(checkout, "config", "--list", "--local")).not.toContain("extraheader");
});

test("scrubCredentials leaves a URL that carries none alone", () => {
  expect(scrubCredentials("fatal: could not read from https://github.com/acme/api.git")).toBe(
    "fatal: could not read from https://github.com/acme/api.git",
  );
});
