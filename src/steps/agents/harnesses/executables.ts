import { accessSync, constants, statSync } from "node:fs";
import path from "node:path";

// Which binary a harness step runs. Both providers would otherwise pick a copy
// out of their own node_modules, which is not the one the operator logged in.

function findOnPath(name: string, env: NodeJS.ProcessEnv): string | undefined {
  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    if (dir === "") continue;
    const candidate = path.join(dir, name);
    try {
      // A directory can carry the x bit too, hence isFile.
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // keep scanning
    }
  }
  return undefined;
}

export function resolveClaudeExecutable(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.JIGS_CLAUDE_EXECUTABLE;
  if (override !== undefined && override !== "") return override;
  const found = findOnPath("claude", env);
  if (found !== undefined) return found;
  throw new Error(
    "no `claude` executable found on PATH — install the Claude Code CLI, or set JIGS_CLAUDE_EXECUTABLE",
  );
}

export function resolveCodexExecutable(env: NodeJS.ProcessEnv = process.env): string {
  const found = findOnPath("codex", env);
  if (found !== undefined) return found;
  throw new Error("no `codex` executable found on PATH — install the Codex CLI");
}

// agent_settled has been public since 0.80.4, so every supported Pi exposes
// the completion boundary the JSON-mode driver requires.
export const MIN_PI_VERSION = "0.85.1";

export function resolvePiExecutable(env: NodeJS.ProcessEnv = process.env): string {
  const found = findOnPath("pi", env);
  if (found !== undefined) return found;
  throw new Error("no `pi` executable found on PATH — install @earendil-works/pi-coding-agent");
}
