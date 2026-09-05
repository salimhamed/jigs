import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { git, makeTmpDir, removeTmpDir } from "../test-fixtures.ts";
import { ensureBindingClone } from "./clone.ts";

let tmp: string;
let remoteDir: string;
let repoDir: string;

beforeEach(() => {
  tmp = makeTmpDir();
  remoteDir = path.join(tmp, "remote.git");
  git(tmp, "init", "-q", "--bare", "--initial-branch", "main", remoteDir);
  const seed = path.join(tmp, "seed");
  git(tmp, "init", "-q", "--initial-branch", "main", seed);
  git(seed, "config", "user.name", "jigs-fixture");
  git(seed, "config", "user.email", "fixture@jigs.test");
  git(seed, "commit", "-q", "--allow-empty", "-m", "initial");
  git(seed, "remote", "add", "origin", remoteDir);
  git(seed, "push", "-q", "origin", "main");
  repoDir = path.join(tmp, "binding", "repo.git");
});
afterEach(() => {
  removeTmpDir(tmp);
});

const lockPath = () => path.join(tmp, "clone.lock");

test("the clone mirrors origin's branches and claims none of refs/heads", async () => {
  await ensureBindingClone({
    remote: remoteDir,
    repoDir,
    lockPath: lockPath(),
  });

  expect(git(repoDir, "config", "remote.origin.fetch")).toBe(
    "+refs/heads/*:refs/remotes/origin/*",
  );
  expect(git(repoDir, "rev-parse", "refs/remotes/origin/main")).toBe(
    git(remoteDir, "rev-parse", "refs/heads/main"),
  );
  expect(
    git(repoDir, "for-each-ref", "--format=%(refname)", "refs/heads"),
  ).toBe("");
});

test("the clone records origin's default branch", async () => {
  await ensureBindingClone({
    remote: remoteDir,
    repoDir,
    lockPath: lockPath(),
  });
  expect(git(repoDir, "symbolic-ref", "refs/remotes/origin/HEAD")).toBe(
    "refs/remotes/origin/main",
  );
});

test("a second call is a no-op on an existing clone", async () => {
  await ensureBindingClone({
    remote: remoteDir,
    repoDir,
    lockPath: lockPath(),
  });
  const head = git(repoDir, "rev-parse", "refs/remotes/origin/main");
  // A branch of jigs' own: a re-clone or a mirror fetch would wipe it.
  git(repoDir, "branch", "agent/keep", "refs/remotes/origin/main");

  await ensureBindingClone({
    remote: remoteDir,
    repoDir,
    lockPath: lockPath(),
  });
  expect(git(repoDir, "rev-parse", "refs/heads/agent/keep")).toBe(head);
});

test("a drifted remote url is repointed in place", async () => {
  await ensureBindingClone({
    remote: remoteDir,
    repoDir,
    lockPath: lockPath(),
  });
  git(repoDir, "remote", "set-url", "origin", "git@github.com:acme/moved.git");

  await ensureBindingClone({
    remote: remoteDir,
    repoDir,
    lockPath: lockPath(),
  });
  expect(git(repoDir, "remote", "get-url", "origin")).toBe(remoteDir);
});

test("a failing fetch leaves no clone behind to be mistaken for a finished one", async () => {
  const unreachable = path.join(tmp, "nonexistent.git");
  await expect(
    ensureBindingClone({
      remote: unreachable,
      repoDir,
      lockPath: lockPath(),
    }),
  ).rejects.toThrow(unreachable);

  expect(existsSync(repoDir)).toBe(false);
  expect(readdirSync(path.dirname(repoDir))).toEqual([]);
});

test("two concurrent callers clone once", async () => {
  await Promise.all([
    ensureBindingClone({ remote: remoteDir, repoDir, lockPath: lockPath() }),
    ensureBindingClone({ remote: remoteDir, repoDir, lockPath: lockPath() }),
  ]);
  expect(git(repoDir, "rev-parse", "refs/remotes/origin/main")).toBe(
    git(remoteDir, "rev-parse", "refs/heads/main"),
  );
});

test("a partial left by a hard-killed clone is reclaimed, whatever its pid", async () => {
  const orphan = `${repoDir}.partial-999999`;
  mkdirSync(orphan, { recursive: true });
  writeFileSync(path.join(orphan, "junk"), "half a clone\n");

  await ensureBindingClone({
    remote: remoteDir,
    repoDir,
    lockPath: lockPath(),
  });

  expect(existsSync(orphan)).toBe(false);
  expect(
    readdirSync(path.dirname(repoDir)).filter((entry) =>
      entry.includes(".partial-"),
    ),
  ).toEqual([]);
});
