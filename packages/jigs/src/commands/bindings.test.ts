import { readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  git,
  makeFactoryRepo,
  makeTargetRepo,
  makeTmpDir,
  removeTmpDir,
} from "../test-fixtures.ts";
import { bindRepo } from "./bind.ts";
import { listBindings } from "./bindings.ts";

let tmp: string;
let factory: string;

beforeEach(() => {
  tmp = makeTmpDir();
  factory = makeFactoryRepo(tmp);
});
afterEach(() => {
  removeTmpDir(tmp);
});

const deps = () => ({ cwd: factory, home: tmp, out: () => {} });

test("a healthy binding reports ok with the derived default branch", async () => {
  const target = makeTargetRepo(tmp, { defaultBranch: "main" });
  await bindRepo(target, deps());
  const [row] = await listBindings(deps());
  expect(row).toMatchObject({
    name: "target-repo",
    path: "~/target-repo",
    state: "ok (default: main)",
  });
});

test("an unset remote HEAD reports ok with a repair hint", async () => {
  const target = makeTargetRepo(tmp);
  await bindRepo(target, deps());
  const [row] = await listBindings(deps());
  expect(row?.state).toContain("ok (default: unknown");
  expect(row?.state).toContain("git remote set-head");
});

test("a moved checkout reports path missing", async () => {
  const target = makeTargetRepo(tmp);
  await bindRepo(target, deps());
  rmSync(target, { recursive: true });
  const [row] = await listBindings(deps());
  expect(row?.state).toBe("path missing");
});

test("a replaced checkout fails loudly naming the found remote", async () => {
  const target = makeTargetRepo(tmp, {
    remoteUrl: "git@github.com:acme/api.git",
  });
  await bindRepo(target, deps());
  git(
    target,
    "remote",
    "set-url",
    "origin",
    "https://github.com/other/api.git",
  );
  const [row] = await listBindings(deps());
  expect(row?.state).toBe(
    "remote mismatch: found https://github.com/other/api.git",
  );
});

test("notes carry ff_default_branch and workspace_dir", async () => {
  const target = makeTargetRepo(tmp, { defaultBranch: "main" });
  await bindRepo(target, deps());
  const configPath = path.join(factory, "jigs.yml");
  writeFileSync(
    configPath,
    `${readFileSync(configPath, "utf8")}    workspace_dir: ~/worktrees\n    ff_default_branch: false\n`,
  );
  const [row] = await listBindings(deps());
  expect(row?.notes).toEqual([
    "ff_default_branch: off",
    "workspace_dir: ~/worktrees",
  ]);
});

test("bindings outside a factory repo fails with guidance", async () => {
  await expect(listBindings({ cwd: tmp })).rejects.toThrow(
    "not inside a factory repo",
  );
});
