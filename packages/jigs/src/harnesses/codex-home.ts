import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { jigsDataDir } from "../paths.ts";

// The managed Codex home (ADR 0011): codex has no strict-config flag, so
// deny-by-default is enforced by pointing CODEX_HOME at a jigs-owned
// directory holding a curated zero-server config.toml and the real login.

export const CURATED_CONFIG_TOML = `# jigs managed CODEX_HOME — curated by jigs on every ensure.
# Deliberately declares zero mcp_servers: a step's explicit mcpServers config
# is the entire MCP universe the agent sees (ADR 0011).
`;

export interface CodexHomeOptions {
  baseDir?: string;
  realAuthPath?: string;
}

export class CodexAuthMissingError extends Error {
  constructor(realAuthPath: string) {
    super(`no Codex login found at ${realAuthPath} — run: codex login`);
    this.name = "CodexAuthMissingError";
  }
}

export function managedCodexHomePath(
  runKey: string,
  options: CodexHomeOptions = {},
): string {
  const base = options.baseDir ?? path.join(jigsDataDir(), "codex-homes");
  return path.join(base, runKey);
}

// Idempotent ensure, never a wipe: rollouts under <home>/sessions are the
// resume store, so the home is per-run durable state that must survive
// between wakes. config.toml IS rewritten on every ensure — codex prepends
// [projects."<cwd>"] trust records into it (the managed home is codex-mutable
// state), and re-curation restores the zero-server invariant.
export function ensureManagedCodexHome(
  runKey: string,
  options: CodexHomeOptions = {},
): string {
  const home = managedCodexHomePath(runKey, options);
  const realAuthPath =
    options.realAuthPath ?? path.join(homedir(), ".codex", "auth.json");
  if (!existsSync(realAuthPath)) {
    throw new CodexAuthMissingError(realAuthPath);
  }
  mkdirSync(home, { recursive: true });
  writeFileSync(path.join(home, "config.toml"), CURATED_CONFIG_TOML);

  // Symlink, never copy: refresh tokens rotate one-time-use, so two copies
  // fight to mutual invalidation. auth.json writes are in-place truncate, so
  // the symlink survives every refresh. A regular file here is a stale copy
  // — the dangerous case — and is replaced.
  const authLink = path.join(home, "auth.json");
  let linked = false;
  try {
    const stat = lstatSync(authLink);
    if (stat.isSymbolicLink() && readlinkSync(authLink) === realAuthPath) {
      linked = true;
    } else {
      rmSync(authLink);
    }
  } catch {
    // no auth.json yet
  }
  if (!linked) symlinkSync(realAuthPath, authLink);
  return home;
}

// Explicit teardown for the run-end path (wired by the worktree lifecycle).
export function removeManagedCodexHome(
  runKey: string,
  options: CodexHomeOptions = {},
): void {
  rmSync(managedCodexHomePath(runKey, options), {
    recursive: true,
    force: true,
  });
}
