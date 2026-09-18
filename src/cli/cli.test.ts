import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  expect(run(cwd, "ps", "--service-url", "not-a-url").stderr).toContain("not-a-url");
});
