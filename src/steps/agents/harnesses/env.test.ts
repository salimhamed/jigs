import { expect, test } from "vitest";
import { claudeDriver } from "../drivers/claude.ts";
import { codexDriver } from "../drivers/codex.ts";
import { piDriver } from "../drivers/pi.ts";
import { harnessEnv } from "./env.ts";

const service = () => ({
  PATH: "/usr/bin",
  HOME: "/home/tester",
  LANG: "en_US.UTF-8",
  LC_TIME: "en_GB.UTF-8",
  HTTPS_PROXY: "http://proxy:3128",
  SSL_CERT_FILE: "/etc/ssl/cert.pem",
  XDG_RUNTIME_DIR: "/run/user/1000",
  CLAUDE_CONFIG_DIR: "/home/tester/.claude-work",
  SYNTHETIC_DATABASE_URL: "postgres://user:secret@db/app",
  SYNTHETIC_PRIVATE_KEY: "key",
  WORKFLOW_POSTGRES_URL: "postgres://jigs:secret@db/jigs",
  OPENROUTER_API_KEY: "sk-or",
  ANTHROPIC_API_KEY: "sk-ant",
  GITHUB_TOKEN: "ghp",
  CLAUDECODE: "1",
  CLAUDE_CODE_ENTRYPOINT: "cli",
  MISE_DATA_DIR: "/home/tester/.mise",
  SSH_AUTH_SOCK: "/run/user/1000/ssh",
});

// Names only: a failing assertion never prints a value.
const names = (env: Record<string, string>) => Object.keys(env).sort();

test("a harness starts from the base set and nothing else", () => {
  expect(names(harnessEnv([], service()))).toEqual(
    ["PATH", "HOME", "LANG", "LC_TIME", "HTTPS_PROXY", "SSL_CERT_FILE", "XDG_RUNTIME_DIR"].sort(),
  );
});

test("named variables are added, and only when the service has them", () => {
  const env = harnessEnv(["MISE_DATA_DIR", "SSH_AUTH_SOCK", "NOT_SET"], service());
  expect(names(env)).toEqual(
    [...names(harnessEnv([], service())), "MISE_DATA_DIR", "SSH_AUTH_SOCK"].sort(),
  );
});

test("secrets reach a harness only when its driver or the factory names them", () => {
  const ask = { harness: { kind: "claude" as const, model: "sonnet" }, prompt: "p" };
  const claude = harnessEnv(claudeDriver.envAllowlist(ask), service());
  expect(names(claude)).toEqual([...names(harnessEnv([], service())), "CLAUDE_CONFIG_DIR"].sort());

  const codex = harnessEnv(
    codexDriver.envAllowlist({
      harness: { kind: "codex", model: "m" },
      cwd: "/w",
      prompt: "p",
    }),
    service(),
  );
  expect(names(codex)).toEqual(names(harnessEnv([], service())));

  const pi = harnessEnv(
    piDriver.envAllowlist({
      harness: {
        kind: "pi",
        model: { kind: "openrouter", model: "m", apiKeyEnv: "OPENROUTER_API_KEY" },
      },
      prompt: "p",
    }),
    service(),
  );
  expect(names(pi)).toEqual([...names(harnessEnv([], service())), "OPENROUTER_API_KEY"].sort());

  expect(names(harnessEnv(["SYNTHETIC_DATABASE_URL"], service()))).toContain(
    "SYNTHETIC_DATABASE_URL",
  );
});

test("Pi reaches the session bus only for an OAuth MCP server", () => {
  const withServer = (auth: "oauth" | false) =>
    piDriver.envAllowlist({
      harness: {
        kind: "pi",
        model: { kind: "openai-codex", model: "m" },
        mcpServers: {
          team: { url: "https://mcp.example", auth, tools: ["t"], probe: { tool: "t" } },
        },
      },
      cwd: "/w",
      prompt: "p",
    });
  expect(withServer("oauth")).toContain("DBUS_SESSION_BUS_ADDRESS");
  expect(withServer(false)).not.toContain("DBUS_SESSION_BUS_ADDRESS");
});
