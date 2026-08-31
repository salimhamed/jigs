import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "smol-toml";

// The load-bearing JIT guard from ADR 0011: codex auto-trusts a writable cwd
// (thread/start persists a trust record) — and since AGE-359 agent steps run
// under danger-full-access, so that is every step — and a worktree's
// .codex/config.toml can declare mcp_servers even under the managed home,
// which no sandbox policy prevents. This callable check is
// what makes deny-by-default hold; it is registered in the check catalog as a
// JIT check. A real TOML parse, not a regex — TOML admits too many spellings
// and a false negative here defeats deny-by-default entirely.

export type GuardResult =
  | { ok: true }
  | {
      ok: false;
      reason: "mcp-servers-declared";
      configPath: string;
      servers: string[];
      repair: string;
    }
  | {
      ok: false;
      reason: "unparseable-config";
      configPath: string;
      repair: string;
    };

export function checkWorktreeCodexMcpConfig(worktreeDir: string): GuardResult {
  const configPath = path.join(worktreeDir, ".codex", "config.toml");
  if (!existsSync(configPath)) return { ok: true };

  let parsed: Record<string, unknown>;
  try {
    parsed = parse(readFileSync(configPath, "utf8"));
  } catch {
    // Fail closed: a config we can't read is a config we can't clear.
    return {
      ok: false,
      reason: "unparseable-config",
      configPath,
      repair: `fix or remove ${configPath} — it could not be parsed as TOML`,
    };
  }

  const mcpServers = parsed.mcp_servers;
  if (typeof mcpServers === "object" && mcpServers !== null) {
    const servers = Object.keys(mcpServers).sort();
    if (servers.length > 0) {
      return {
        ok: false,
        reason: "mcp-servers-declared",
        configPath,
        servers,
        repair: `remove the mcp_servers table (${servers.join(", ")}) from ${configPath} — MCP servers are declared per step, never repo-owned (ADR 0011)`,
      };
    }
  }
  return { ok: true };
}
