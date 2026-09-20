import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { readFactoryConfig } from "../config/factory-config.ts";

const cli = fileURLToPath(new URL("./cli.ts", import.meta.url));
const run = (cwd: string, ...args: string[]) =>
  spawnSync(process.execPath, [cli, ...args], { cwd, encoding: "utf8" });

test("explicit GitHub flags reach the scaffold through the CLI parser", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "jigs-cli-"));
  try {
    const result = run(
      cwd,
      "init",
      "--github-identity-mode",
      "app",
      "--github-app-id",
      "123",
      "--github-app-installation",
      "some-org=10",
      "--github-app-installation",
      "Other=20",
      "--github-app-private-key-path",
      "app.pem",
      "--github-operator-login",
      "human",
      "--git-co-author",
      "Human <human@example.com>",
    );
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    // Scaffold installation is a separate command; load only its emitted settings here.
    const configFile = path.join(cwd, "jigs.config.ts");
    writeFileSync(
      configFile,
      readFileSync(configFile, "utf8").replace(
        'import { defineFactory } from "@salimhamed/jigs";',
        "const defineFactory = (factory) => factory;",
      ),
    );
    expect(readFactoryConfig(cwd).github.identities).toEqual([
      {
        mode: "app",
        appId: 123,
        installations: { "some-org": 10, Other: 20 },
        privateKeyPath: "app.pem",
        operator: "human",
        coAuthor: "Human <human@example.com>",
      },
    ]);
    const bound = run(
      cwd,
      "bind",
      "git@github.com:some-org/example.git",
      "--binding-name",
      "example-alias",
    );
    expect(bound.status).toBe(0);
    expect(readFactoryConfig(cwd).bindings["example-alias"]?.remote).toBe(
      "git@github.com:some-org/example.git",
    );
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
    expect(noArgs.stdout).toContain("Everyday commands:");
    expect(noArgs.stdout).toContain("Connecting code repositories:");
    expect(noArgs.stdout).toContain("Ready-made workflows:");
    expect(noArgs.stdout).toContain("Inspecting and cleaning working files:");
    expect(noArgs.stdout).toContain("Background service:");
    expect(noArgs.stdout).toContain("Advanced commands:");
    expect(noArgs.stdout).toContain("jigs run ship --input ticket=AGE-123");
    expect(noArgs.stdout).toContain("each workflow defines its own inputs");
    expect(noArgs.stdout.indexOf("jigs init")).toBeLessThan(noArgs.stdout.indexOf("jigs bind"));
    expect(noArgs.stdout).not.toMatch(/jigs (ps|sweep)\b/);
    expect(noArgs.stdout).not.toMatch(/^\s*jigs logs\b/m);
    expect(existsSync(path.join(cwd, "package.json"))).toBe(false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("workflow and run command help uses explicit placeholders", () => {
  const cwd = tmpdir();
  expect(run(cwd, "run", "--help").stdout).toContain("<workflow-name>");
  const status = run(cwd, "status", "--help").stdout;
  expect(status).toContain("[run-id]");
  expect(status).toContain("unique ID prefix");
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
  expect(prune.stdout).toContain("preview safe local resource cleanup");
  expect(prune.stdout).toContain("--apply");
  expect(prune.stdout).toContain("--include-kept");
  expect(prune.stdout).toContain("--run <run-id>");
  expect(prune.stdout).toContain("--json");
});
