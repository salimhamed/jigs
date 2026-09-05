import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  git,
  makeFactoryRepo,
  makeRemoteBackedRepo,
  makeTmpDir,
  removeTmpDir,
} from "../test-fixtures.ts";
import { ensureBindingClone } from "../worktrees/clone.ts";
import { bindingRepoDir } from "../worktrees/layout.ts";
import { listBindings } from "./bindings.ts";

let tmp: string;
let factory: string;
let remoteDir: string;

beforeEach(() => {
  tmp = makeTmpDir();
  remoteDir = makeRemoteBackedRepo(tmp).remoteDir;
  // A local bare repo stands in for GitHub, so the clone is real and offline.
  factory = makeFactoryRepo(
    tmp,
    `bindings:\n  api:\n    remote: ${remoteDir}\n`,
  );
  vi.stubEnv("XDG_DATA_HOME", path.join(tmp, "data"));
});
afterEach(() => {
  vi.unstubAllEnvs();
  removeTmpDir(tmp);
});

const deps = () => ({ cwd: factory });

const cloneDir = () =>
  bindingRepoDir({ factoryRoot: factory, bindingName: "api" });

test("a binding with no clone yet reports where the clone will land", async () => {
  const [row] = await listBindings(deps());
  expect(row).toEqual({
    name: "api",
    remote: remoteDir,
    clone: cloneDir(),
    state: "not cloned (cloned on the first worktree)",
  });
});

test("a cloned binding reports the default branch it derived", async () => {
  const repoDir = cloneDir();
  await ensureBindingClone({ repoDir, remote: remoteDir });
  const [row] = await listBindings(deps());
  expect(row?.state).toBe("cloned (default: main)");
});

test("a clone whose remote no longer matches names the url it found", async () => {
  const repoDir = cloneDir();
  await ensureBindingClone({ repoDir, remote: remoteDir });
  git(repoDir, "remote", "set-url", "origin", "git@github.com:other/api.git");
  const [row] = await listBindings(deps());
  expect(row?.state).toBe(
    "cloned, remote drifted: git@github.com:other/api.git",
  );
});

test("a clone that lost its remote HEAD says the next fetch will set it", async () => {
  const repoDir = cloneDir();
  await ensureBindingClone({ repoDir, remote: remoteDir });
  git(repoDir, "symbolic-ref", "-d", "refs/remotes/origin/HEAD");
  const [row] = await listBindings(deps());
  expect(row?.state).toBe(
    "cloned (default: unknown — will be set on the next fetch)",
  );
});

test("bindings outside a factory repo fails with guidance", async () => {
  await expect(listBindings({ cwd: tmp })).rejects.toThrow(
    "not inside a factory repo",
  );
});
