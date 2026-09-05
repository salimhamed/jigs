import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { git, makeTmpDir, removeTmpDir } from "../test-fixtures.ts";
import { ensureBindingClone } from "./clone.ts";

let tmp: string;
let remoteDir: string;
let repoDir: string;

beforeEach(() => {
  tmp = makeTmpDir();
  // The clone lock derives from jigsDataDir(), so the data dir is what a test
  // redirects to keep its locks out of the developer's own.
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

test("the clone mirrors origin's branches and claims none of refs/heads", async () => {
  await ensureBindingClone({ remote: remoteDir, repoDir });

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
  await ensureBindingClone({ remote: remoteDir, repoDir });
  expect(git(repoDir, "symbolic-ref", "refs/remotes/origin/HEAD")).toBe(
    "refs/remotes/origin/main",
  );
});

test("a second call is a no-op on an existing clone", async () => {
  await ensureBindingClone({ remote: remoteDir, repoDir });
  const head = git(repoDir, "rev-parse", "refs/remotes/origin/main");
  // A branch of jigs' own: a re-clone or a mirror fetch would wipe it.
  git(repoDir, "branch", "agent/keep", "refs/remotes/origin/main");

  await ensureBindingClone({ remote: remoteDir, repoDir });
  expect(git(repoDir, "rev-parse", "refs/heads/agent/keep")).toBe(head);
});

test("a drifted remote url is repointed in place", async () => {
  await ensureBindingClone({ remote: remoteDir, repoDir });
  git(repoDir, "remote", "set-url", "origin", "git@github.com:acme/moved.git");

  await ensureBindingClone({ remote: remoteDir, repoDir });
  expect(git(repoDir, "remote", "get-url", "origin")).toBe(remoteDir);
});

test("a failing fetch leaves no clone behind to be mistaken for a finished one", async () => {
  const unreachable = path.join(tmp, "nonexistent.git");
  await expect(
    ensureBindingClone({ remote: unreachable, repoDir }),
  ).rejects.toThrow(unreachable);

  expect(existsSync(repoDir)).toBe(false);
  expect(readdirSync(path.dirname(repoDir))).toEqual([]);
});

test("two concurrent callers clone once", async () => {
  await Promise.all([
    ensureBindingClone({ remote: remoteDir, repoDir }),
    ensureBindingClone({ remote: remoteDir, repoDir }),
  ]);
  expect(git(repoDir, "rev-parse", "refs/remotes/origin/main")).toBe(
    git(remoteDir, "rev-parse", "refs/heads/main"),
  );
});

test("a partial left by a hard-killed clone is reclaimed, whatever its pid", async () => {
  const orphan = `${repoDir}.partial-999999`;
  mkdirSync(orphan, { recursive: true });
  writeFileSync(path.join(orphan, "junk"), "half a clone\n");

  await ensureBindingClone({ remote: remoteDir, repoDir });

  expect(existsSync(orphan)).toBe(false);
  expect(
    readdirSync(path.dirname(repoDir)).filter((entry) =>
      entry.includes(".partial-"),
    ),
  ).toEqual([]);
});

test("an empty repo.git self-heals: the rename into place succeeds over it", async () => {
  mkdirSync(repoDir, { recursive: true });

  await ensureBindingClone({ remote: remoteDir, repoDir });
  expect(git(repoDir, "rev-parse", "refs/remotes/origin/main")).toBe(
    git(remoteDir, "rev-parse", "refs/heads/main"),
  );
});

test("a repo.git left without a HEAD is named as unfinished, not a clone failure", async () => {
  mkdirSync(repoDir, { recursive: true });
  writeFileSync(path.join(repoDir, "config"), "[core]\n");

  const failure = await ensureBindingClone({
    remote: remoteDir,
    repoDir,
  }).then(
    () => null,
    (err: unknown) => err,
  );
  expect(String(failure)).toContain("unfinished");
  expect((failure as { hint?: string }).hint).toContain(`rm -rf ${repoDir}`);
});
