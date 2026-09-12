import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ensureBindingClone } from "../steps/worktree/clone.ts";
import { bindingRepoDir } from "../steps/worktree/layout.ts";
import {
  makeFactoryRepo,
  makeRemoteBackedRepo,
  makeTmpDir,
  removeTmpDir,
} from "../test-fixtures.ts";
import { bindingChecks } from "./bindings.ts";
import { runChecks } from "./catalog.ts";

let tmp: string;

beforeEach(() => {
  tmp = makeTmpDir();
  vi.stubEnv("XDG_DATA_HOME", path.join(tmp, "data"));
});
afterEach(() => {
  vi.unstubAllEnvs();
  removeTmpDir(tmp);
});

const yml = (name: string, remote: string) => ({
  bindings: { [name]: { remote } },
});

// Stands in for the clone the service makes at start, for the cases whose
// remote is deliberately unreachable.
function markClone(factoryRoot: string, name: string): void {
  const dir = path.join(
    bindingRepoDir({ factoryRoot, bindingName: name }),
    "refs/remotes/origin",
  );
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "HEAD"), "ref: refs/remotes/origin/main\n");
}

async function check(factoryRoot: string, name: string) {
  const report = await runChecks(
    bindingChecks({ factoryRoot: () => factoryRoot, names: [name] }),
  );
  const outcome = report.checks[0];
  if (outcome === undefined) throw new Error("no outcome");
  return outcome;
}

test("an undeclared binding fails with the exact jigs bind invocation", async () => {
  const factory = makeFactoryRepo(tmp, { bindings: {} });
  const outcome = await check(factory, "api");
  expect(outcome).toMatchObject({
    id: "binding.api",
    ok: false,
    reason: expect.stringContaining("no binding named 'api'"),
    repair: expect.stringContaining("jigs bind"),
  });
  expect(outcome.ok === false && outcome.repair).toContain("--name api");
  expect(outcome.ok === false && outcome.repair).toContain("remote-url");
});

test("a declared binding with no clone yet names the restart that makes one", async () => {
  const { remoteDir } = makeRemoteBackedRepo(tmp);
  const factory = makeFactoryRepo(tmp, yml("api", remoteDir));
  expect(await check(factory, "api")).toMatchObject({
    ok: false,
    reason: "binding api has no clone yet",
    repair:
      "restart the service: jigs service restart (it clones every binding on start)",
  });
});

test("a binding whose remote cannot be reached fails the auth probe", async () => {
  const unreachable = path.join(tmp, "nonexistent.git");
  const factory = makeFactoryRepo(tmp, yml("api", unreachable));
  markClone(factory, "api");
  const outcome = await check(factory, "api");
  expect(outcome).toMatchObject({
    ok: false,
    reason: expect.stringContaining("git could not reach"),
  });
});

test("a declared, cloned binding whose remote answers passes", async () => {
  const { remoteDir } = makeRemoteBackedRepo(tmp);
  const factory = makeFactoryRepo(tmp, yml("api", remoteDir));
  await ensureBindingClone({
    repoDir: bindingRepoDir({ factoryRoot: factory, bindingName: "api" }),
    remote: remoteDir,
  });
  expect(await check(factory, "api")).toEqual({
    id: "binding.api",
    label: "binding api",
    ok: true,
  });
});

test("a missing jigs.config.ts collapses to one failed check naming the file, not a throw", async () => {
  const root = path.join(tmp, "no-factory-here");
  const report = await runChecks(
    bindingChecks({ factoryRoot: () => root, names: ["api", "web"] }),
  );
  expect(report.checks).toHaveLength(1);
  expect(report.checks[0]).toMatchObject({
    id: "binding.factory-config",
    ok: false,
    repair: expect.stringContaining(path.join(root, "jigs.config.ts")),
  });
});

test("an unparseable jigs.config.ts collapses to one failed check", async () => {
  const factory = makeFactoryRepo(
    tmp,
    "export default { bindings: { api: { remote: [",
  );
  const report = await runChecks(
    bindingChecks({ factoryRoot: () => factory, names: ["api"] }),
  );
  expect(report.checks).toHaveLength(1);
  expect(report.checks[0]).toMatchObject({
    id: "binding.factory-config",
    ok: false,
  });
});

test("a workflow requiring no bindings needs no factory config at all", () => {
  expect(
    bindingChecks({
      factoryRoot: () => path.join(tmp, "no-factory-here"),
      names: [],
    }),
  ).toEqual([]);
});
