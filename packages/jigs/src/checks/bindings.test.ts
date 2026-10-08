import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { resolveFactoryContext } from "../config/factory-context.ts";
import * as git from "../providers/git.ts";
import * as githubApi from "../providers/github-api.ts";
import { GitHubApiError } from "../providers/github-http.ts";
import { ensureBindingClone } from "../steps/workspaces/clone.ts";
import { cloneRepoDir } from "../steps/workspaces/layout.ts";
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
  bindings: { [name]: { remote, installationName: "acme" } },
});

// Stands in for the clone the service makes at start, for the cases whose
// remote is deliberately unreachable.
function markClone(factoryRoot: string, name: string): void {
  const dir = path.join(cloneRepoDir({ factoryRoot, bindingName: name }), "refs/remotes/origin");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "HEAD"), "ref: refs/remotes/origin/main\n");
}

async function check(factoryRoot: string, name: string) {
  const report = await runChecks(
    bindingChecks({ context: resolveFactoryContext(factoryRoot), names: [name] }),
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
    repair: expect.stringContaining("pnpm exec jigs bind"),
  });
  expect(outcome.ok === false && outcome.repair).toContain("--binding-name api");
  expect(outcome.ok === false && outcome.repair).toContain("remote-url");
});

test("a declared binding with no clone yet names the restart that makes one", async () => {
  const { remoteDir } = makeRemoteBackedRepo(tmp);
  const factory = makeFactoryRepo(tmp, yml("api", remoteDir));
  expect(await check(factory, "api")).toMatchObject({
    ok: false,
    reason: "binding api has no clone yet",
    repair:
      "the service clones every binding when it starts, so restart it: `pnpm exec jigs up --restart-service`",
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
    repoDir: cloneRepoDir({ factoryRoot: factory, bindingName: "api" }),
    remote: remoteDir,
  });
  expect(await check(factory, "api")).toEqual({
    id: "binding.api",
    label: "binding api",
    ok: true,
  });
});

function githubBinding(reach: () => Promise<unknown>) {
  const factory = makeFactoryRepo(tmp, yml("api", "git@github.com:acme/api.git"));
  markClone(factory, "api");
  vi.spyOn(git, "probeRemoteAuth").mockResolvedValue(null);
  const asked: string[] = [];
  vi.spyOn(githubApi, "githubGet").mockImplementation(async (installationName, apiPath) => {
    asked.push(`${installationName} ${apiPath}`);
    return reach();
  });
  return { factory, asked };
}

test("a GitHub binding's installation that reaches its repository passes", async () => {
  const { factory, asked } = githubBinding(async () => ({}));
  expect(await check(factory, "api")).toEqual({
    id: "binding.api",
    label: "binding api",
    ok: true,
  });
  expect(asked).toEqual(["acme /repos/acme/api"]);
});

test("a GitHub binding's installation that cannot see its repository names the setting", async () => {
  const { factory } = githubBinding(async () => {
    throw new GitHubApiError(404, "/repos/acme/api", '{"message":"Not Found"}');
  });
  expect(await check(factory, "api")).toMatchObject({
    ok: false,
    reason: "GitHub installation acme cannot reach acme/api",
    repair: expect.stringContaining("set bindings.api.installationName in jigs.config.ts"),
  });
});

test("a copy entry with no file under the binding's folder fails before the clone checks, naming the path", async () => {
  const factory = makeFactoryRepo(tmp, {
    bindings: {
      api: {
        remote: path.join(tmp, "nonexistent.git"),
        installationName: "acme",
        copy: [".env", "certs/*.pem"],
      },
    },
  });
  mkdirSync(path.join(factory, "bindings/api/certs"), { recursive: true });
  writeFileSync(path.join(factory, "bindings/api/certs/ca.pem"), "pem\n");
  expect(await check(factory, "api")).toEqual({
    id: "binding.api",
    label: "binding api",
    ok: false,
    reason: "binding api: copy entry .env matches nothing under bindings/api/",
    repair: `add a file matching .env under ${path.join(factory, "bindings/api")}/, or remove the entry from jigs.config.ts`,
  });
});

test("a copy entry pointing outside the binding's folder fails the check", async () => {
  const factory = makeFactoryRepo(tmp, {
    bindings: {
      api: {
        remote: path.join(tmp, "nonexistent.git"),
        installationName: "acme",
        copy: ["../elsewhere/.env"],
      },
    },
  });
  mkdirSync(path.join(factory, "bindings/elsewhere"), { recursive: true });
  writeFileSync(path.join(factory, "bindings/elsewhere/.env"), "A=1\n");
  expect(await check(factory, "api")).toMatchObject({
    ok: false,
    reason:
      "binding api: copy entry ../elsewhere/.env must be a relative path inside bindings/api/",
    repair: expect.stringContaining("relative to bindings/api/"),
  });
});

test("a cloned binding whose copy entries all match passes", async () => {
  const { remoteDir } = makeRemoteBackedRepo(tmp);
  const factory = makeFactoryRepo(tmp, {
    bindings: { api: { remote: remoteDir, installationName: "acme", copy: [".env"] } },
  });
  mkdirSync(path.join(factory, "bindings/api"), { recursive: true });
  writeFileSync(path.join(factory, "bindings/api/.env"), "A=1\n");
  await ensureBindingClone({
    repoDir: cloneRepoDir({ factoryRoot: factory, bindingName: "api" }),
    remote: remoteDir,
  });
  expect(await check(factory, "api")).toMatchObject({ ok: true });
});

test("a missing jigs.config.ts collapses to one failed check naming the file, not a throw", async () => {
  const root = path.join(tmp, "no-factory-here");
  const report = await runChecks(
    bindingChecks({ context: resolveFactoryContext(root), names: ["api", "web"] }),
  );
  expect(report.checks).toHaveLength(1);
  expect(report.checks[0]).toMatchObject({
    id: "binding.factory-config",
    ok: false,
    repair: expect.stringContaining(path.join(root, "jigs.config.ts")),
  });
});

test("an unparseable jigs.config.ts collapses to one failed check", async () => {
  const factory = makeFactoryRepo(tmp, "export default { bindings: { api: { remote: [");
  const report = await runChecks(
    bindingChecks({ context: resolveFactoryContext(factory), names: ["api"] }),
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
      context: resolveFactoryContext(path.join(tmp, "no-factory-here")),
      names: [],
    }),
  ).toEqual([]);
});
