import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { jigsDataDir } from "../../../config/paths.ts";
import type { PiModelPlan } from "./pi-model.ts";

export interface PiHomeOptions {
  baseDir?: string;
  invocationBaseDir?: string;
  realAuthPath?: string;
}

export interface PreparedPiHome {
  home: string;
  sessionDir: string;
  cleanup(): void;
}

/** Return the operator login file linked into Pi invocation homes. */
export function realPiAuthPath(home: string = homedir()): string {
  return path.join(home, ".pi", "agent", "auth.json");
}

/** Return the durable per-run Pi state path. */
export function piRunStatePath(runId: string, options: PiHomeOptions = {}): string {
  return path.join(options.baseDir ?? path.join(jigsDataDir(), "pi-homes"), runId);
}

/** Return the durable directory that holds a run's Pi sessions. */
export function piSessionsDir(runState: string): string {
  return path.join(runState, "sessions");
}

/** Find and stat the real Pi session file for an exact session id. */
export function piSessionFile(sessionDir: string, sessionId: string): string | undefined {
  for (const name of readdirSync(sessionDir)) {
    if (!name.endsWith(`_${sessionId}.jsonl`)) continue;
    const candidate = path.join(sessionDir, name);
    if (statSync(candidate).isFile()) return candidate;
  }
  return undefined;
}

/** Prepare private invocation configuration beside durable per-run sessions. */
export function preparePiInvocationHome(
  runId: string,
  plan: PiModelPlan,
  options: PiHomeOptions = {},
): PreparedPiHome {
  const realAuthPath = plan.subscriptionAuth
    ? (options.realAuthPath ?? realPiAuthPath())
    : undefined;
  if (realAuthPath !== undefined && !existsSync(realAuthPath)) {
    throw new Error(`no Pi openai-codex login found at ${realAuthPath} — run: pi /login`);
  }

  const runState = piRunStatePath(runId, options);
  const sessionDir = piSessionsDir(runState);
  mkdirSync(sessionDir, { recursive: true });
  const invocationBaseDir = options.invocationBaseDir ?? path.join(runState, "invocations");
  mkdirSync(invocationBaseDir, { recursive: true });
  const home = mkdtempSync(path.join(invocationBaseDir, "invocation-"));
  try {
    writeFileSync(
      path.join(home, "settings.json"),
      `${JSON.stringify({ packages: [] }, null, 2)}\n`,
    );
    const modelsPath = path.join(home, "models.json");
    if (plan.models !== undefined)
      writeFileSync(modelsPath, `${JSON.stringify(plan.models, null, 2)}\n`);
    if (realAuthPath !== undefined) {
      // Symlink, never copy: OAuth refresh tokens rotate and must remain shared
      // with the operator's one real Pi login file.
      symlinkSync(realAuthPath, path.join(home, "auth.json"));
    }
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
