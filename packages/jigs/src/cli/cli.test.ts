import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { readFactoryConfig } from "../config/factory-config.ts";
import { makeFactoryRepo, makeTmpDir, removeTmpDir } from "../test-fixtures.ts";
import { JIGS_VERSION } from "../version.ts";

const cli = fileURLToPath(new URL("./cli.ts", import.meta.url));
const run = (cwd: string, ...args: string[]) =>
  spawnSync(process.execPath, [cli, ...args], { cwd, encoding: "utf8" });

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
    );
    // With no hub behind it the label leg fails, after the binding is recorded.
    expect(bound.status).not.toBe(0);
    expect(bound.stderr).toContain("jigs:approved label could not be ensured");
    const config = readFactoryConfig(cwd);
    expect(config.bindings["example-alias"]?.remote).toBe("git@github.com:some-org/example.git");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("renamed value flags reach validation instead of falling back to defaults", () => {
  const cwd = tmpdir();
  expect(run(cwd, "upgrade", "--to-version", "latest").stderr).toContain(
    "--to-version takes an exact version",
  );
  expect(run(cwd, "watch", "--poll-interval-seconds", "0").stderr).toContain(
    "--poll-interval-seconds must be a positive number",
  );
  expect(run(cwd, "status", "--service-url", "not-a-url").stderr).toContain("not-a-url");
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
      "Generated code:",
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

test("hub connect takes a token that starts with a dash", () => {
  const tmp = makeTmpDir();
  try {
    const factory = makeFactoryRepo(tmp);
    writeFileSync(path.join(factory, ".env"), "JIGS_HUB_TOKEN=\n");
    const result = run(factory, "hub", "connect", "https://hub.acme.test", "-dash-token");
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(readFileSync(path.join(factory, ".env"), "utf8")).toBe("JIGS_HUB_TOKEN=-dash-token\n");
  } finally {
    removeTmpDir(tmp);
  }
});

test("workflow and run command help uses explicit placeholders", () => {
  const cwd = tmpdir();
  expect(run(cwd, "run", "--help").stdout).toContain("<workflow-name>");
  const status = run(cwd, "status", "--help").stdout;
  expect(status).toContain("[run-id]");
  expect(status).toContain("the run's full ID");
  expect(status).not.toContain("prefix");
  expect(run(cwd, "watch", "--help").stdout).toContain("[run-id]");
  expect(run(cwd, "cancel", "--help").stdout).toContain("<run-id>");
});

test("repository and recipe command help uses explicit placeholders", () => {
  const cwd = tmpdir();
  const bind = run(cwd, "bind", "--help").stdout;
  expect(bind).toContain("<remote-url>");
  expect(bind).toContain("<binding-name>");
  expect(run(cwd, "unbind", "--help").stdout).toContain("<binding-name>");
  expect(run(cwd, "recipe", "add", "--help").stdout).toContain("<recipe-name>");
});

test("upgrade and service command help uses explicit placeholders", () => {
  const cwd = tmpdir();
  expect(run(cwd, "upgrade", "--help").stdout).toContain("<version>");
  expect(run(cwd, "service", "logs", "--help").stdout).toContain("<line-count>");
});

test("removed commands are not registered", () => {
  const cwd = tmpdir();
  for (const command of ["ps", "logs", "sweep"]) {
    const result = run(cwd, command);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`unknown command '${command}'`);
  }
});

test("resource maintenance help exposes preview, apply, run, JSON and kept-resource controls", () => {
  const cwd = tmpdir();
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
