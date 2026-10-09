import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, test } from "vitest";
import { readFactoryConfig } from "../config/factory-config.ts";
import { makeFactoryRepo, makeTmpDir, removeTmpDir } from "../test-fixtures.ts";
import { JIGS_VERSION } from "../version.ts";

const cli = fileURLToPath(new URL("./cli.ts", import.meta.url));
const run = (cwd: string, ...args: string[]) =>
  spawnSync(process.execPath, [cli, ...args], { cwd, encoding: "utf8" });

let factoryParent: string;
let factoryRoot: string;
beforeAll(() => {
  factoryParent = makeTmpDir();
  factoryRoot = makeFactoryRepo(factoryParent);
});
afterAll(() => removeTmpDir(factoryParent));

test("init scaffolds through the CLI parser, and bind records its binding", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "jigs-cli-"));
  try {
    const result = run(cwd, "init");
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    // Scaffold installation is a separate command; load only its emitted settings here.
    const configFile = path.join(cwd, "jigs.config.ts");
    writeFileSync(
      configFile,
      readFileSync(configFile, "utf8").replace(
        'import { defineFactory } from "@jigs-ai/jigs";',
        "const defineFactory = (factory) => factory;",
      ),
    );
    const bound = run(
      cwd,
      "bind",
      "git@github.com:some-org/example.git",
      "--binding-name",
      "example-alias",
      "--installation",
      "github-some-org",
    );
    // With no hub behind it the label leg fails, after the binding is recorded.
    expect(bound.status).not.toBe(0);
    expect(bound.stderr).toContain("jigs:approved label could not be ensured");
    const config = readFactoryConfig(cwd);
    expect(config.bindings["example-alias"]).toMatchObject({
      remote: "git@github.com:some-org/example.git",
      installationName: "github-some-org",
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("renamed value flags reach validation instead of falling back to defaults", () => {
  const cwd = factoryRoot;
  expect(run(cwd, "watch", "--poll-interval-seconds", "0").stderr).toContain(
    "--poll-interval-seconds must be a positive number",
  );
  expect(run(cwd, "status", "--service-url", "not-a-url").stderr).toContain("not-a-url");
});

test("a command loads the factory's config from its root before reading the environment", () => {
  const parent = makeTmpDir();
  try {
    const root = makeFactoryRepo(
      parent,
      `process.env.JIGS_SERVICE_URL = "set-by-config";\nexport default ${JSON.stringify({ hub: { url: "https://hub.example.test" }, workflows: {} })};\n`,
    );
    const nested = path.join(root, "workflows");
    mkdirSync(nested);
    expect(run(nested, "status").stderr).toContain("set-by-config");
  } finally {
    removeTmpDir(parent);
  }
});

test("a command outside a factory stops before it runs", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "jigs-outside-"));
  try {
    const result = run(cwd, "status", "--service-url", "http://localhost:1");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("not inside a factory repo");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("root and no-argument help are side-effect-free, grouped and exact", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "jigs-help-"));
  try {
    const noArgs = run(cwd);
    const explicit = run(cwd, "--help");
    expect(noArgs.status).toBe(0);
    expect(noArgs.stderr).toBe("");
    expect(noArgs.stdout).toBe(explicit.stdout);
    expect(noArgs.stdout.startsWith("Usage: jigs <command> [options]\n\nSet up:\n")).toBe(true);
    const sections = noArgs.stdout.split("\n").filter((line) => /^\S.*:$/.test(line));
    expect(sections).toEqual([
      "Set up:",
      "Start and stop:",
      "Service process:",
      "Workflows and runs:",
      "Repositories:",
      "Recipes:",
      "Resources:",
      "Build:",
      "Options:",
    ]);
    expect(noArgs.stdout).toMatch(/^ {2}down {2,}Stop the service and Postgres; data is kept$/m);
    expect(noArgs.stdout).toMatch(
      /^ {2}service stop {2,}Stop the service; Postgres keeps running$/m,
    );
    expect(noArgs.stdout).toContain("pnpm exec jigs <command>; add --help for its options");
    expect(noArgs.stdout).not.toMatch(/\bship\b/);
    expect(noArgs.stdout).not.toContain("Getting started");
    expect(noArgs.stdout).not.toMatch(/jigs (ps|sweep)\b/);
    expect(noArgs.stdout).not.toMatch(/^\s*jigs logs\b/m);
    expect(existsSync(path.join(cwd, "package.json"))).toBe(false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("--version prints the installed jigs version", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "jigs-version-"));
  try {
    for (const flag of ["--version", "-V"]) {
      const result = run(cwd, flag);
      expect(result.status).toBe(0);
      expect(result.stdout).toBe(`${JIGS_VERSION}\n`);
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("workflow and run command help uses explicit placeholders", () => {
  const cwd = factoryRoot;
  expect(run(cwd, "run", "--help").stdout).toContain("<workflow-name>");
  const status = run(cwd, "status", "--help").stdout;
  expect(status).toContain("[run-id]");
  expect(status).toContain("the run's full ID");
  expect(status).not.toContain("prefix");
  expect(run(cwd, "watch", "--help").stdout).toContain("[run-id]");
  expect(run(cwd, "cancel", "--help").stdout).toContain("<run-id>");
});

test("repository and recipe command help uses explicit placeholders", () => {
  const cwd = factoryRoot;
  const bind = run(cwd, "bind", "--help").stdout;
  expect(bind).toContain("<remote-url>");
  expect(bind).toContain("<binding-name>");
  expect(bind).toContain("--installation <installation-name>");
  expect(run(cwd, "unbind", "--help").stdout).toContain("<binding-name>");
  expect(run(cwd, "recipe", "add", "--help").stdout).toContain("<recipe-name>");
});

test("service command help uses explicit placeholders", () => {
  const cwd = factoryRoot;
  expect(run(cwd, "service", "logs", "--help").stdout).toContain("<line-count>");
});

test("removed commands are not registered", () => {
  const cwd = factoryRoot;
  for (const command of ["ps", "logs", "sweep", "hub"]) {
    const result = run(cwd, command);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`unknown command '${command}'`);
  }
});

test("resource maintenance help exposes preview, apply, run, JSON and kept-resource controls", () => {
  const cwd = factoryRoot;
  const root = run(cwd, "resources", "--help");
  expect(root.status).toBe(0);
  expect(root.stdout).toContain("list");
  expect(root.stdout).toContain("prune");

  const list = run(cwd, "resources", "list", "--help");
  expect(list.stdout).toContain("--run <run-id>");
  expect(list.stdout).toContain("--json");

  const prune = run(cwd, "resources", "prune", "--help");
  expect(prune.stdout).toContain("preview removing finished runs' resources");
  expect(prune.stdout).toContain("--apply");
  expect(prune.stdout).not.toContain("--include-kept");
  expect(prune.stdout).toContain("--run <run-id>");
  expect(prune.stdout).toContain("--json");
});
