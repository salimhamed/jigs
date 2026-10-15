import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { githubAuthFor } from "../../providers/github-auth.ts";
import { git, makeTmpDir, removeTmpDir } from "../../test-fixtures.ts";
import { ensureBindingClone, hasBindingClone } from "./clone.ts";

vi.mock("../../providers/github-auth.ts", () => ({
  githubAuthFor: vi.fn(() => ({ bearer: async () => "ghs_test" })),
}));

let tmp: string;
let remoteDir: string;
let repoDir: string;

beforeEach(() => {
  tmp = makeTmpDir();
  vi.stubEnv("XDG_DATA_HOME", path.join(tmp, "xdg"));
  remoteDir = path.join(tmp, "remote.git");
  git(tmp, "init", "-q", "--bare", "--initial-branch", "main", remoteDir);
  const bootstrap = path.join(tmp, "bootstrap");
  git(tmp, "init", "-q", "--initial-branch", "main", bootstrap);
  git(bootstrap, "config", "user.name", "jigs-fixture");
  git(bootstrap, "config", "user.email", "fixture@jigs.test");
  git(bootstrap, "commit", "-q", "--allow-empty", "-m", "initial");
  git(bootstrap, "remote", "add", "origin", remoteDir);
  git(bootstrap, "push", "-q", "origin", "main");
  repoDir = path.join(tmp, "binding", "repo.git");
});
afterEach(() => {
  vi.unstubAllEnvs();
  removeTmpDir(tmp);
});

const marker = () => path.join(repoDir, "refs", "remotes", "origin", "HEAD");

// Every object the clone holds — loose ones included, which is where a small
// fixture keeps all of them — by path and mtime. A re-download rewrites this;
// a resumed clone must not. objects/info is skipped: commit-graphs are a
// derived index git may rebuild whenever it likes, not objects.
const objects = () => {
  const dir = path.join(repoDir, "objects");
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((entry) => !entry.startsWith("info"))
    .flatMap((entry) => {
      const stats = statSync(path.join(dir, entry));
      return stats.isDirectory() ? [] : [`${entry} ${stats.mtimeMs}`];
    })
    .sort();
};

const clone = (url = remoteDir, installationName = "github-acme") =>
  ensureBindingClone({ repoDir, url, installationName });

test("the clone mirrors origin's branches and claims none of refs/heads", async () => {
  await clone();

  expect(git(repoDir, "config", "remote.origin.fetch")).toBe("+refs/heads/*:refs/remotes/origin/*");
  expect(git(repoDir, "rev-parse", "refs/remotes/origin/main")).toBe(
    git(remoteDir, "rev-parse", "refs/heads/main"),
  );
  expect(git(repoDir, "for-each-ref", "--format=%(refname)", "refs/heads")).toBe("");
});

test("the clone records origin's default branch as the finished marker", async () => {
  await clone();
  expect(git(repoDir, "symbolic-ref", "refs/remotes/origin/HEAD")).toBe("refs/remotes/origin/main");
  expect(hasBindingClone(repoDir)).toBe(true);
});

test("a second call fetches nothing and keeps jigs' own branches", async () => {
  await clone();
  const head = git(repoDir, "rev-parse", "refs/remotes/origin/main");
  // A branch of jigs' own: a re-clone or a mirror fetch would wipe it.
  git(repoDir, "branch", "agent/keep", "refs/remotes/origin/main");
  // Nothing on the remote can reach this clone once the remote is gone, so a
  // second fetch would fail rather than quietly no-op.
  rmSync(remoteDir, { recursive: true, force: true });

  await clone();
  expect(git(repoDir, "rev-parse", "refs/heads/agent/keep")).toBe(head);
});

test("a clone interrupted before its marker resumes over the objects it has", async () => {
  await clone();
  const before = objects();
  const counted = git(repoDir, "count-objects", "-v");
  // Guards the two assertions below against passing on an empty listing.
  expect(before.length).toBeGreaterThan(0);
  rmSync(marker());
  expect(hasBindingClone(repoDir)).toBe(false);

  await clone();
  expect(hasBindingClone(repoDir)).toBe(true);
  expect(objects()).toEqual(before);
  expect(git(repoDir, "count-objects", "-v")).toBe(counted);
});

test("the clone fetches as the binding's installation, and follows a change of either", async () => {
  await clone();
  expect(githubAuthFor).toHaveBeenLastCalledWith("github-acme");
  git(repoDir, "remote", "set-url", "origin", "https://github.com/acme/moved.git");

  await clone(remoteDir, "github-other");
  expect(git(repoDir, "remote", "get-url", "origin")).toBe(remoteDir);
  expect(git(repoDir, "config", "jigs.installation")).toBe("github-other");
});

test("a failing fetch leaves no marker, and the next call finishes the clone", async () => {
  const unreachable = path.join(tmp, "nonexistent.git");
  await expect(clone(unreachable)).rejects.toThrow(unreachable);
  expect(hasBindingClone(repoDir)).toBe(false);

  await clone();
  expect(git(repoDir, "rev-parse", "refs/remotes/origin/main")).toBe(
    git(remoteDir, "rev-parse", "refs/heads/main"),
  );
});

test("a binding with no clone directory at all is not mistaken for one", () => {
  expect(existsSync(repoDir)).toBe(false);
  expect(hasBindingClone(repoDir)).toBe(false);
});
