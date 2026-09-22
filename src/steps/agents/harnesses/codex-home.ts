import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { jigsDataDir } from "../../../config/paths.ts";

// Codex has no strict-config flag. Each invocation therefore receives a
// private CODEX_HOME with a curated zero-server config and a link to the
// run's durable rollout directory.
export const CURATED_CONFIG_TOML = `# jigs invocation-private CODEX_HOME.
# Deliberately declares zero mcp_servers: a step's explicit mcpServers config
# is the entire MCP universe the agent sees.
`;

export function realCodexAuthPath(home: string = homedir()): string {
  return path.join(home, ".codex", "auth.json");
}

export interface CodexHomeOptions {
  baseDir?: string;
  invocationBaseDir?: string;
  realAuthPath?: string;
}

export interface PreparedCodexHome {
  home: string;
  sessionDir: string;
  cleanup(): void;
}

/** Return the durable per-run Codex state path. */
export function managedCodexHomePath(runId: string, options: CodexHomeOptions = {}): string {
  const base = options.baseDir ?? path.join(jigsDataDir(), "codex-homes");
  return path.join(base, runId);
}

/** Return the durable rollout directory for a workflow run. */
export function codexSessionsDir(runState: string): string {
  return path.join(runState, "sessions");
}

function rolloutFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...rolloutFiles(candidate));
    else if (entry.isFile()) files.push(candidate);
  }
  return files;
}

/** Find a rollout whose metadata exactly names the requested thread. */
export function codexSessionFile(sessionDir: string, threadId: string): string | undefined {
  for (const candidate of rolloutFiles(sessionDir)) {
    if (!path.basename(candidate).endsWith(`-${threadId}.jsonl`)) continue;
    const firstLine = readFileSync(candidate, "utf8").split("\n", 1)[0];
    if (firstLine === undefined || firstLine === "") continue;
    try {
      const first = JSON.parse(firstLine) as { type?: unknown; payload?: { id?: unknown } };
      if (first.type === "session_meta" && first.payload?.id === threadId) return candidate;
    } catch {
      // A matching filename with invalid metadata is not a resumable rollout.
    }
  }
  return undefined;
}

/** Prepare private Codex configuration linked to durable per-run rollouts. */
export function prepareManagedCodexHome(
  runId: string,
  options: CodexHomeOptions = {},
): PreparedCodexHome {
  const realAuthPath = options.realAuthPath ?? realCodexAuthPath();
  if (!existsSync(realAuthPath)) {
    throw new Error(`no Codex login found at ${realAuthPath} — run: codex login`);
  }

  const runState = managedCodexHomePath(runId, options);
  const sessionDir = codexSessionsDir(runState);
  mkdirSync(sessionDir, { recursive: true });
  const invocationBaseDir = options.invocationBaseDir ?? path.join(runState, "invocations");
  mkdirSync(invocationBaseDir, { recursive: true });
  const home = mkdtempSync(path.join(invocationBaseDir, "invocation-"));
  try {
    writeFileSync(path.join(home, "config.toml"), CURATED_CONFIG_TOML);
    symlinkSync(realAuthPath, path.join(home, "auth.json"));
    symlinkSync(sessionDir, path.join(home, "sessions"));
  } catch (error) {
    rmSync(home, { recursive: true, force: true });
    throw error;
  }
  return {
    home,
    sessionDir,
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
}

/** Remove durable Codex sessions after all of a run's worktrees are released. */
export function removeManagedCodexHome(runId: string, options: CodexHomeOptions = {}): void {
  rmSync(managedCodexHomePath(runId, options), { recursive: true, force: true });
}

/** Test whether an invocation home still links to the expected auth file. */
export function codexAuthLink(home: string): string | undefined {
  const auth = path.join(home, "auth.json");
  try {
    return lstatSync(auth).isSymbolicLink() ? readlinkSync(auth) : undefined;
  } catch {
    return undefined;
  }
}
