import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { locateTemplates, packageRoot } from "./templates.ts";

// Names jigs reads that a factory never puts in .env: test seams, values jigs
// sets on the service itself, the host environment agents inherit, model
// credentials agents may not be handed, and the CLI's own shell setting.
const NOT_IN_ENV_EXAMPLE = new Set([
  "GITHUB_API_URL",
  "LINEAR_API_URL",
  "SLACK_API_URL",
  "JIGS_DASHBOARD_PORT",
  "JIGS_FACTORY_ROOT",
  "WORKFLOW_LOCAL_BASE_URL",
  "WORKFLOW_POSTGRES_APPLICATION_MANAGED_SHUTDOWN",
  "PATH",
  "GIT_SSH_COMMAND",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_RUNTIME_DIR",
  "XDG_STATE_HOME",
  "DBUS_SESSION_BUS_ADDRESS",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "RUST_LOG",
  "VIRTUAL_ENV",
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
  "PI_CODING_AGENT_DIR",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  "JIGS_SERVICE_URL",
]);

// Quoted constants shaped like environment names that are not ones.
const NOT_ENV_NAMES = new Set([
  "AUTHENTICATION_ERROR",
  "CHANGES_REQUESTED",
  "ERR_SERVER_NOT_RUNNING",
  "REQUEST_CHANGES",
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

// Every name read as `env.NAME`, plus every quoted NAME_LIKE_THIS constant,
// since most credentials are looked up by a name held in a constant.
function envNamesReadBySource(): Set<string> {
  const names = new Set<string>();
  for (const file of sourceFiles(path.join(packageRoot(), "src"))) {
    const code = readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
      .join("\n");
    for (const match of code.matchAll(/\benv\.([A-Z][A-Z0-9_]*)\b/g)) names.add(match[1] ?? "");
    for (const match of code.matchAll(/["']([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)["']/g))
      names.add(match[1] ?? "");
  }
  for (const name of NOT_ENV_NAMES) names.delete(name);
  return names;
}

// Commented-out keys count: they are documented, just not set by default.
function envExampleNames(): string[] {
  const text = readFileSync(path.join(locateTemplates(), ".env.example.tmpl"), "utf8");
  return [...text.matchAll(/^(?:# )?([A-Z][A-Z0-9_]*)=/gm)].map((match) => match[1] ?? "");
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
  const table = guide.slice(guide.indexOf("## `.env` {#env}")).split("\n## ")[0] ?? "";
  const documented = [...table.matchAll(/^\| (.+?) \|/gm)].flatMap((row) =>
    [...(row[1] ?? "").matchAll(/`([A-Z][A-Z0-9_]*)`/g)].map((name) => name[1] ?? ""),
  );
  expect(documented).toEqual(envExampleNames());
});
