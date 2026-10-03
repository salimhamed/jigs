import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { makeTmpDir, removeTmpDir } from "../test-fixtures.ts";
import type { McpServerConfig } from "../workflow/agents/harness-config.ts";
import { runChecks } from "./catalog.ts";
import { jitChecks } from "./index.ts";
import { codexWorktreeConfigCheck, mcpServerChecks } from "./mcp.ts";

// A real stdio MCP server child process, not a mock: the whole point of the
// JIT check is that only a real tool call is evidence.
const PROBE_SERVER = fileURLToPath(
  new URL("../steps/agents/harnesses/live/fixtures/mcp-probe-server.mjs", import.meta.url),
);

let tmp: string;

beforeEach(() => {
  tmp = makeTmpDir();
});
afterEach(() => {
  removeTmpDir(tmp);
  vi.unstubAllEnvs();
});

async function check(
  server: McpServerConfig,
  cwd = process.cwd(),
  env: Record<string, string> = { PROBE_SOURCE: "t" },
) {
  const report = await runChecks(mcpServerChecks({ linear: server }, cwd, env, { inherit: false }));
  const outcome = report.checks[0];
  if (outcome === undefined) throw new Error("no outcome");
  return outcome;
}

test("a declared server that starts and answers its probe tool passes", async () => {
  expect(
    await check({
      command: "node",
      args: [PROBE_SERVER],
      env: { PROBE_TOKEN: "PROBE_SOURCE" },
      probe: { tool: "get_probe_token" },
    }),
  ).toEqual({ id: "mcp.linear", label: "MCP server linear", ok: true });
});

test("a named variable that is not set fails before the server starts, naming the variable only", async () => {
  const outcome = await check(
    {
      command: "never-started",
      env: { PROBE_TOKEN: "MISSING_PROBE_TOKEN" },
      probe: { tool: "get_probe_token" },
    },
    process.cwd(),
    {},
  );
  expect(outcome).toMatchObject({
    ok: false,
    reason: expect.stringContaining("MISSING_PROBE_TOKEN"),
    repair: expect.stringContaining("set MISSING_PROBE_TOKEN in"),
  });
});

test("a literal credential left in the config fails without appearing in the outcome", async () => {
  const outcome = await check({
    url: "http://127.0.0.1:1/mcp",
    headers: { Authorization: "Bearer lit-eral-secret" },
    probe: { tool: "get_probe_token" },
  });
  expect(outcome.ok).toBe(false);
  expect(JSON.stringify(outcome)).not.toContain("lit-eral-secret");
  expect(JSON.stringify(outcome)).toContain("Authorization");
});

test.each([
  ["a token literal", "ghp_abc123SECRETxyz"],
  ["a lowercase name", "probe_source"],
])("%s fails the check without appearing in its outcome or logs", async (_label, value) => {
  const log = vi.spyOn(console, "log");
  const error = vi.spyOn(console, "error");
  const warn = vi.spyOn(console, "warn");
  const outcome = await check(
    { command: "never-started", env: { PROBE_TOKEN: value }, probe: { tool: "get_probe_token" } },
    process.cwd(),
    { [value]: "set" },
  );
  expect(outcome).toMatchObject({
    ok: false,
    reason: expect.stringContaining("not an environment variable name"),
  });
  const written = JSON.stringify([outcome, log.mock.calls, error.mock.calls, warn.mock.calls]);
  expect(written).not.toContain(value);
});

test("a set bearer token is never echoed when the server then fails", async () => {
  const outcome = await check(
    { url: "http://127.0.0.1:1/mcp", bearerTokenEnv: "PD_TOKEN", probe: { tool: "x" } },
    process.cwd(),
    { PD_TOKEN: "very-secret-token" },
  );
  expect(outcome.ok).toBe(false);
  expect(JSON.stringify(outcome)).not.toContain("very-secret-token");
}, 20_000);

test("a server does not inherit ambient credential-shaped variables", async () => {
  vi.stubEnv("PROBE_TOKEN", "ambient");
  expect(
    await check({
      command: "node",
      args: [PROBE_SERVER],
      probe: { tool: "get_probe_token" },
    }),
  ).toMatchObject({
    id: "mcp.linear",
    label: "MCP server linear",
    ok: false,
    reason: expect.stringContaining("PROBE-TOKEN-UNSET"),
  });
});

// The step hands its JIT checks the environment it hands the harness. Claude
// Code and Codex pass theirs on to a stdio server; Pi's adapter does not.
test("a Claude server is probed under the step environment and a Pi server under its declaration alone", async () => {
  const stepEnv = { PATH: process.env.PATH ?? "", PROBE_TOKEN: "from-step" };
  const server = { command: "node", args: [PROBE_SERVER], probe: { tool: "get_probe_token" } };
  const claude = await runChecks(
    jitChecks(
      { harness: { kind: "claude", model: "m", mcpServers: { s: server } }, cwd: tmp },
      stepEnv,
    ),
  );
  expect(claude.checks.find((outcome) => outcome.id === "mcp.s")).toMatchObject({ ok: true });

  const pi = await runChecks(
    jitChecks(
      {
        harness: {
          kind: "pi",
          model: { kind: "openai-codex", model: "m" },
          mcpServers: { s: { ...server, tools: ["get_probe_token"] } },
        },
        cwd: tmp,
      },
      stepEnv,
    ),
  );
  expect(pi.checks.find((outcome) => outcome.id === "mcp.s")).toMatchObject({
    ok: false,
    reason: expect.stringContaining("PROBE-TOKEN-UNSET"),
  });
});

test("a Pi server's named variables resolve from the step environment, not the service's", async () => {
  vi.stubEnv("PROBE_SOURCE", "ambient");
  const envFile = path.join(tmp, "probe-env.jsonl");
  const probe = (stepEnv: Record<string, string>) =>
    runChecks(
      jitChecks(
        {
          harness: {
            kind: "pi",
            model: { kind: "openai-codex", model: "m" },
            mcpServers: {
              s: {
                command: "node",
                args: [PROBE_SERVER],
                env: { PROBE_TOKEN: "PROBE_SOURCE", PROBE_ENV_FILE: "PROBE_ENV_FILE_SOURCE" },
                tools: ["get_probe_token"],
                probe: { tool: "get_probe_token" },
              },
            },
          },
          cwd: tmp,
        },
        { PATH: process.env.PATH ?? "", PROBE_ENV_FILE_SOURCE: envFile, ...stepEnv },
      ),
    );
  const probedTokens = () =>
    readFileSync(envFile, "utf8")
      .trim()
      .split("\n")
      .map((line) => (JSON.parse(line) as { env: Record<string, string> }).env.PROBE_TOKEN);

  const unset = await probe({});
  expect(unset.checks.find((outcome) => outcome.id === "mcp.s")).toMatchObject({
    ok: false,
    reason: expect.stringContaining("PROBE_SOURCE"),
  });
  await probe({ PROBE_SOURCE: "from-step" });
  expect(probedTokens()).toEqual(["from-step"]);
});

test("a Claude server's named variables resolve from the step environment", async () => {
  const report = await runChecks(
    jitChecks(
      {
        harness: {
          kind: "claude",
          model: "m",
          mcpServers: {
            s: {
              command: "node",
              args: [PROBE_SERVER],
              env: { PROBE_TOKEN: "CLAUDE_PROBE_SOURCE" },
              probe: { tool: "get_probe_token" },
            },
          },
        },
        cwd: tmp,
      },
      { PATH: process.env.PATH ?? "" },
    ),
  );
  expect(report.checks.find((outcome) => outcome.id === "mcp.s")).toMatchObject({
    ok: false,
    reason: expect.stringContaining("CLAUDE_PROBE_SOURCE"),
  });
});

test("a Pi OAuth server is not probed but its named headers must be set", async () => {
  const target = (headers: Record<string, string>) => ({
    harness: {
      kind: "pi" as const,
      model: { kind: "openai-codex" as const, model: "m" },
      mcpServers: {
        s: {
          url: "http://127.0.0.1:1/mcp",
          auth: "oauth" as const,
          headers,
          tools: ["x"],
          probe: { tool: "x" },
        },
      },
    },
    cwd: tmp,
  });
  expect((await runChecks(jitChecks(target({}), {}))).ok).toBe(true);
  const missing = await runChecks(jitChecks(target({ "X-Org": "ORG_ID" }), {}));
  expect(missing.checks.find((outcome) => outcome.id === "mcp.s")).toMatchObject({
    ok: false,
    reason: expect.stringContaining("ORG_ID"),
  });
});

test("a server is spawned in the worktree, so a relative arg resolves the way the step will resolve it", async () => {
  copyFileSync(PROBE_SERVER, path.join(tmp, "probe-server.mjs"));
  const server: McpServerConfig = {
    command: "node",
    args: ["probe-server.mjs"],
    env: { PROBE_TOKEN: "PROBE_SOURCE" },
    probe: { tool: "get_probe_token" },
  };
  expect(await check(server, tmp)).toMatchObject({ ok: true });
  expect(await check(server, path.dirname(tmp))).toMatchObject({
    ok: false,
    reason: expect.stringContaining("did not start or connect"),
  });
});

test("a server whose command cannot start fails with a repair", async () => {
  const outcome = await check({
    command: "definitely-not-a-binary",
    probe: { tool: "get_probe_token" },
  });
  expect(outcome).toMatchObject({
    ok: false,
    reason: expect.stringContaining("did not start or connect"),
    repair: expect.stringContaining("linear"),
  });
});

function failingServer(stderr: string[]): McpServerConfig {
  const script = `${stderr.map((line) => `console.error(${JSON.stringify(line)});`).join("")}process.exit(1);`;
  return { command: "node", args: ["-e", script], probe: { tool: "get_probe_token" } };
}

test("a server that exits before connecting fails quoting the end of its stderr", async () => {
  const lines = Array.from({ length: 12 }, (_, i) => `line ${i}`);
  const outcome = await check(
    failingServer([...lines, "TokenRetrievalError: Token has expired and refresh failed"]),
  );
  expect(outcome).toMatchObject({
    ok: false,
    reason: expect.stringContaining("did not start or connect"),
  });
  const reason = outcome.ok ? "" : outcome.reason;
  expect(reason).toContain("TokenRetrievalError: Token has expired and refresh failed");
  expect(reason).toContain("line 11");
  expect(reason).not.toContain("line 0");
});

test("a failing server's stderr is quoted with its credentials redacted", async () => {
  const outcome = await check(
    {
      ...failingServer([
        "auth failed for very-secret-value",
        "fetching https://user:hunter2pass@example.com/mcp",
      ]),
      env: { PROBE_TOKEN: "PROBE_SOURCE" },
    },
    process.cwd(),
    { PROBE_SOURCE: "very-secret-value" },
  );
  expect(outcome.ok).toBe(false);
  const written = JSON.stringify(outcome);
  expect(written).toContain("auth failed for");
  expect(written).not.toContain("very-secret-value");
  expect(written).not.toContain("hunter2pass");
});

test("an inherited credential-named variable is redacted from a failing server's stderr", async () => {
  const report = await runChecks(
    mcpServerChecks(
      { linear: failingServer(["using inherited-secret-value"]) },
      process.cwd(),
      { GITHUB_TOKEN: "inherited-secret-value" },
      { inherit: true },
    ),
  );
  const written = JSON.stringify(report.checks[0]);
  expect(written).toContain("using");
  expect(written).not.toContain("inherited-secret-value");
});

test("a server that connects but does not expose the probe tool fails naming the tools it does expose", async () => {
  const outcome = await check({
    command: "node",
    args: [PROBE_SERVER],
    probe: { tool: "absent" },
  });
  expect(outcome).toMatchObject({
    ok: false,
    reason: expect.stringContaining("get_probe_token"),
  });
});

test("a server with no declared probe fails rather than being silently skipped", async () => {
  const outcome = await check({
    command: "node",
  } as unknown as McpServerConfig);
  expect(outcome).toMatchObject({
    ok: false,
    reason: expect.stringContaining("declares no probe tool"),
    repair: expect.stringContaining("declare a probe"),
  });
});

test("an unreachable http server fails within the check timeout", async () => {
  // Port 1 is never listening; the connect rejects rather than hanging.
  const outcome = await check({
    url: "http://127.0.0.1:1/mcp",
    probe: { tool: "get_probe_token" },
  });
  expect(outcome).toMatchObject({
    ok: false,
    reason: expect.stringContaining("did not start or connect"),
  });
}, 20_000);

test("a worktree .codex/config.toml declaring mcp_servers fails the catalog check", async () => {
  mkdirSync(path.join(tmp, ".codex"), { recursive: true });
  writeFileSync(
    path.join(tmp, ".codex", "config.toml"),
    '[mcp_servers.sneaky]\ncommand = "node"\n',
  );
  const report = await runChecks([codexWorktreeConfigCheck(tmp)]);
  expect(report.checks[0]).toMatchObject({
    id: "mcp.codex-worktree-config",
    ok: false,
    repair: expect.stringContaining("remove the mcp_servers table"),
  });
});

test("a worktree with no .codex/config.toml passes the catalog check", async () => {
  const report = await runChecks([codexWorktreeConfigCheck(tmp)]);
  expect(report.ok).toBe(true);
});
