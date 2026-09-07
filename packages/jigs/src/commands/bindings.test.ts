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

const printed = async (cwd = factory) => {
  const lines: string[] = [];
  await listBindings({ cwd, out: (line) => lines.push(line) });
  return lines;
};

const cloneDir = () =>
  bindingRepoDir({ factoryRoot: factory, bindingName: "api" });

// "api" pads to the NAME header's width; the remote, clone and state columns
// are each already wider than their header.
const apiRow = (state: string) => `api   ${remoteDir}  ${cloneDir()}  ${state}`;

test("a binding with no clone yet reports where the clone will land", async () => {
  const lines = await printed();
  expect(lines[0]).toMatch(/^NAME {2}REMOTE {2}/);
  expect(lines[1]).toBe(apiRow("not cloned (restart the service)"));
});

test("a cloned binding reports the default branch it derived", async () => {
  await ensureBindingClone({ repoDir: cloneDir(), remote: remoteDir });
  const lines = await printed();
  expect(lines[1]).toBe(apiRow("cloned (default: main)"));
});

test("a clone whose remote no longer matches names the url it found", async () => {
  const repoDir = cloneDir();
  await ensureBindingClone({ repoDir, remote: remoteDir });
  git(repoDir, "remote", "set-url", "origin", "git@github.com:other/api.git");
  const lines = await printed();
  expect(lines[1]).toBe(
    apiRow("cloned, remote drifted: git@github.com:other/api.git"),
  );
});

test("a clone that lost its remote HEAD reports as not cloned, like doctor does", async () => {
  const repoDir = cloneDir();
  await ensureBindingClone({ repoDir, remote: remoteDir });
  git(repoDir, "symbolic-ref", "-d", "refs/remotes/origin/HEAD");
  const lines = await printed();
  expect(lines[1]).toBe(apiRow("not cloned (restart the service)"));
});

test("a factory with no bindings says so instead of printing a header", async () => {
  const other = makeTmpDir();
  try {
    expect(await printed(makeFactoryRepo(other))).toEqual(["no bindings"]);
  } finally {
    removeTmpDir(other);
  }
});

test("bindings outside a factory repo fails with guidance", async () => {
  await expect(printed(tmp)).rejects.toThrow("not inside a factory repo");
});
