import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { locateTemplates, packageRoot } from "../build/templates.ts";

// Names jigs reads that a factory never puts in .env.
const NOT_IN_ENV_EXAMPLE = new Set([
  // Set by jigs on the service process.
  "JIGS_DASHBOARD_PORT",
  "JIGS_FACTORY_ROOT",
  "WORKFLOW_POSTGRES_APPLICATION_MANAGED_SHUTDOWN",
  // Inherited from the host environment.
  "PATH",
  "GIT_SSH_COMMAND",
  "XDG_DATA_HOME",
  "VIRTUAL_ENV",
  "HOME",
  "AWS_CONFIG_FILE",
  "AWS_SHARED_CREDENTIALS_FILE",
  // Model keys agents are never handed; a model source names its own.
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  // Read by the CLI from the operator's shell.
  "JIGS_SERVICE_URL",
  // Set by jigs in the environment of an agent that acts as the factory.
  "GH_TOKEN",
  "GIT_CONFIG_COUNT",
  "JIGS_LINEAR_TOKEN",
  "JIGS_PAGERDUTY_TOKEN",
]);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "live" ? [] : sourceFiles(full);
    const shipped =
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".test.ts") &&
      entry.name !== "test-fixtures.ts";
    return shipped ? [full] : [];
  });
}

// Env reads, plus quoted names shaped like a credential or setting, since
// most credentials are looked up by a name held in a constant.
const ENV_READ = /\benv(?:\.([A-Z][A-Z0-9_]*)\b|\[["']([A-Z][A-Z0-9_]*)["']\])/g;
const QUOTED_ENV_NAME = /["']([A-Z][A-Z0-9_]*_(?:KEY|TOKEN|SECRET|ID|URL|PROFILE|EXECUTABLE))["']/g;

function envNamesReadBySource(): Set<string> {
  const names = new Set<string>();
  for (const file of sourceFiles(path.join(packageRoot(), "src"))) {
    const code = readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
      .join("\n");
    for (const [, dotted, indexed] of code.matchAll(ENV_READ)) names.add(`${dotted ?? indexed}`);
    for (const [, name] of code.matchAll(QUOTED_ENV_NAME)) names.add(`${name}`);
  }
  return names;
}

function envExampleNames(): string[] {
  const text = readFileSync(path.join(locateTemplates(), ".env.example.tmpl"), "utf8");
  return [...text.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map(([, name]) => `${name}`);
}

test(".env.example covers every variable jigs reads from a factory's .env", () => {
  const listed = new Set(envExampleNames());
  const missing = [...envNamesReadBySource()].filter(
    (name) => !listed.has(name) && !NOT_IN_ENV_EXAMPLE.has(name),
  );
  expect(missing).toEqual([]);
});

test("the configuration guide's .env table lists exactly the .env.example variables", () => {
  const guide = readFileSync(path.join(packageRoot(), "site", "guide", "configuration.md"), "utf8");
  const start = guide.indexOf("## `.env` {#env}");
  const table = guide.slice(start, guide.indexOf("\n## ", start + 1));
  const documented = [...table.matchAll(/^\| (.+?) \|/gm)].flatMap(([, variables]) =>
    [...`${variables}`.matchAll(/`([A-Z][A-Z0-9_]*)`/g)].map(([, name]) => `${name}`),
  );
  expect(documented).toEqual(envExampleNames());
});
