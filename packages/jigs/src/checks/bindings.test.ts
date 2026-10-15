import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { resolveFactoryContext } from "../config/factory-context.ts";
import * as git from "../providers/git.ts";
import * as githubAuth from "../providers/github-auth.ts";
import { makeFactoryRepo, makeTmpDir, removeTmpDir } from "../test-fixtures.ts";
import { bindingChecks } from "./bindings.ts";
import { PROBE_TIMEOUT_MS, runChecks } from "./catalog.ts";

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

function githubBinding(probe: string | null = null) {
  const factory = makeFactoryRepo(tmp, yml("api", "git@github.com:acme/api.git"));
  vi.stubEnv("JIGS_HUB_TOKEN", "hub-token");
  vi.spyOn(githubAuth, "githubAuthFor").mockReturnValue({
    bearer: async () => "ghs_token",
  } as unknown as githubAuth.GithubAuth);
  const probed = vi.spyOn(git, "probeRemoteAuth").mockResolvedValue(probe);
  return { factory, probed };
}

test("a binding with no clone passes when its installation reaches the repository over git", async () => {
  const { factory, probed } = githubBinding();
  expect(await check(factory, "api")).toEqual({
    id: "binding.api",
    label: "binding api",
    ok: true,
  });
  expect(probed).toHaveBeenCalledWith(
    "https://github.com/acme/api.git",
    "ghs_token",
    PROBE_TIMEOUT_MS,
  );
});

test("an installation that cannot fetch the repository's code fails the check", async () => {
  const { factory } = githubBinding("fatal: repository not found");
  expect(await check(factory, "api")).toMatchObject({
    ok: false,
    reason:
      "git could not reach acme/api through GitHub installation acme: fatal: repository not found",
    repair: expect.stringContaining("give installation acme read access to acme/api's contents"),
  });
});

test("a copy entry with no file under the binding's folder fails before the clone checks, naming the path", async () => {
  const factory = makeFactoryRepo(tmp, {
    bindings: {
      api: {
        remote: "git@github.com:acme/api.git",
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
        remote: "git@github.com:acme/api.git",
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

test("a binding whose copy entries all match passes", async () => {
  const factory = makeFactoryRepo(tmp, {
    bindings: {
      api: { remote: "git@github.com:acme/api.git", installationName: "acme", copy: [".env"] },
    },
  });
  mkdirSync(path.join(factory, "bindings/api"), { recursive: true });
  writeFileSync(path.join(factory, "bindings/api/.env"), "A=1\n");
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
