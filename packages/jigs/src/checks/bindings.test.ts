import { mkdirSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  makeFactoryRepo,
  makeRemoteBackedRepo,
  makeTargetRepo,
  makeTmpDir,
  removeTmpDir,
} from "../test-fixtures.ts";
import { bindingChecks } from "./bindings.ts";
import { runChecks } from "./catalog.ts";

let tmp: string;

beforeEach(() => {
  tmp = makeTmpDir();
});
afterEach(() => {
  removeTmpDir(tmp);
});

const yml = (name: string, dir: string, remote: string) =>
  `bindings:\n  ${name}:\n    path: ${dir}\n    remote: ${remote}\n`;

async function check(factoryRoot: string, name: string) {
  const report = await runChecks(
    bindingChecks({ factoryRoot: () => factoryRoot, names: [name] }),
  );
  const outcome = report.checks[0];
  if (outcome === undefined) throw new Error("no outcome");
  return outcome;
}

test("an undeclared binding fails with the exact jigs bind invocation", async () => {
  const factory = makeFactoryRepo(tmp, "bindings: {}\n");
  const outcome = await check(factory, "api");
  expect(outcome).toMatchObject({
    id: "binding.api",
    ok: false,
    reason: expect.stringContaining("no binding named 'api'"),
    repair: expect.stringContaining("jigs bind"),
  });
  expect(outcome.ok === false && outcome.repair).toContain("--name api");
});

test("a binding whose checkout is missing fails with a repair", async () => {
  const missing = path.join(tmp, "gone");
  const factory = makeFactoryRepo(
    tmp,
    yml("api", missing, "git@x:acme/api.git"),
  );
  const outcome = await check(factory, "api");
  expect(outcome).toMatchObject({
    ok: false,
    reason: expect.stringContaining("does not exist"),
    repair: expect.stringContaining("git@x:acme/api.git"),
  });
});

test("a binding pointing at a non-git directory fails", async () => {
  const plain = path.join(tmp, "plain");
  mkdirSync(plain);
  const factory = makeFactoryRepo(tmp, yml("api", plain, "git@x:acme/api.git"));
  const outcome = await check(factory, "api");
  expect(outcome).toMatchObject({
    ok: false,
    reason: expect.stringContaining("is not a git checkout"),
  });
});

test("a binding whose remote no longer matches the pin names both URLs", async () => {
  const repo = makeTargetRepo(tmp, {
    remoteUrl: "git@github.com:acme/moved.git",
  });
  const factory = makeFactoryRepo(
    tmp,
    yml("api", repo, "git@github.com:acme/api.git"),
  );
  const outcome = await check(factory, "api");
  expect(outcome.ok).toBe(false);
  const reason = outcome.ok === false ? outcome.reason : "";
  expect(reason).toContain("git@github.com:acme/moved.git");
  expect(reason).toContain("git@github.com:acme/api.git");
});

test("a binding whose remote cannot be reached fails the auth probe", async () => {
  const unreachable = path.join(tmp, "nonexistent.git");
  const repo = makeTargetRepo(tmp, { remoteUrl: unreachable });
  const factory = makeFactoryRepo(tmp, yml("api", repo, unreachable));
  const outcome = await check(factory, "api");
  expect(outcome).toMatchObject({
    ok: false,
    reason: expect.stringContaining("git could not reach"),
  });
});

test("a fully wired binding passes", async () => {
  const { checkout, remoteDir } = makeRemoteBackedRepo(tmp);
  const factory = makeFactoryRepo(tmp, yml("api", checkout, remoteDir));
  expect(await check(factory, "api")).toEqual({
    id: "binding.api",
    label: "binding api",
    ok: true,
  });
});

test("a missing jigs.yml collapses to one failed check naming the file, not a throw", async () => {
  const root = path.join(tmp, "no-factory-here");
  const report = await runChecks(
    bindingChecks({ factoryRoot: () => root, names: ["api", "web"] }),
  );
  expect(report.checks).toHaveLength(1);
  expect(report.checks[0]).toMatchObject({
    id: "binding.factory-config",
    ok: false,
    repair: expect.stringContaining(path.join(root, "jigs.yml")),
  });
});

test("an unparseable jigs.yml collapses to one failed check", async () => {
  const factory = makeFactoryRepo(tmp, "bindings:\n  api:\n    path: [\n");
  const report = await runChecks(
    bindingChecks({ factoryRoot: () => factory, names: ["api"] }),
  );
  expect(report.checks).toHaveLength(1);
  expect(report.checks[0]).toMatchObject({
    id: "binding.factory-config",
    ok: false,
  });
});

test("a pipeline requiring no bindings needs no factory config at all", () => {
  expect(
    bindingChecks({
      factoryRoot: () => path.join(tmp, "no-factory-here"),
      names: [],
    }),
  ).toEqual([]);
});
