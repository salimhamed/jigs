import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { ModelSource, OpenaiCompatibleSource } from "../../../blocks/agents/harness-config.ts";
import { jigsDataDir } from "../../../config/paths.ts";

export interface PiHomeOptions {
  baseDir?: string;
  realAuthPath?: string;
}

/** Return the operator login file shared with managed Pi homes. */
export function realPiAuthPath(home: string = homedir()): string {
  return path.join(home, ".pi", "agent", "auth.json");
}

/** Return the durable per-run Pi home path. */
export function managedPiHomePath(runId: string, options: PiHomeOptions = {}): string {
  return path.join(options.baseDir ?? path.join(jigsDataDir(), "pi-homes"), runId);
}

/** Remove the managed Pi home after all of a run's worktrees are released. */
export function removeManagedPiHome(runId: string, options: PiHomeOptions = {}): void {
  rmSync(managedPiHomePath(runId, options), { recursive: true, force: true });
}

/** Return the managed directory that holds a run's Pi sessions. */
export function piSessionsDir(home: string): string {
  return path.join(home, "sessions");
}

/** Find and stat the real Pi session file for an exact session id. */
export function piSessionFile(home: string, sessionId: string): string | undefined {
  const directory = piSessionsDir(home);
  for (const name of readdirSync(directory)) {
    if (!name.endsWith(`_${sessionId}.jsonl`)) continue;
    const candidate = path.join(directory, name);
    if (statSync(candidate).isFile()) return candidate;
  }
  return undefined;
}

function openaiCompatibleModels(source: OpenaiCompatibleSource): object {
  return {
    providers: {
      [source.name]: {
        baseUrl: source.baseUrl,
        api: "openai-completions",
        apiKey: source.apiKeyEnv === undefined ? "jigs" : `$${source.apiKeyEnv}`,
        compat: source.compat,
        models: [
          {
            id: source.model,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        ],
      },
    },
  };
}

/** Ensure the isolated per-run Pi home exists and rewrite its jigs-owned configuration. */
export function ensureManagedPiHome(
  runId: string,
  source: ModelSource,
  options: PiHomeOptions = {},
): string {
  const home = managedPiHomePath(runId, options);
  mkdirSync(piSessionsDir(home), { recursive: true });
  writeFileSync(path.join(home, "settings.json"), `${JSON.stringify({ packages: [] }, null, 2)}\n`);
  const modelsPath = path.join(home, "models.json");
  if (source.kind === "openai-compatible")
    writeFileSync(modelsPath, `${JSON.stringify(openaiCompatibleModels(source), null, 2)}\n`);
  else rmSync(modelsPath, { force: true });
  if (source.kind === "openai-codex") {
    const realAuthPath = options.realAuthPath ?? realPiAuthPath();
    if (!existsSync(realAuthPath))
      throw new Error(`no Pi openai-codex login found at ${realAuthPath} — run: pi /login`);
    const authLink = path.join(home, "auth.json");
    let linked = false;
    try {
      const stat = lstatSync(authLink);
      if (stat.isSymbolicLink() && readlinkSync(authLink) === realAuthPath) linked = true;
      else rmSync(authLink);
    } catch {
      // no auth.json yet
    }
    // Symlink, never copy: OAuth refresh tokens rotate and must remain shared
    // with the operator's one real Pi login file.
    if (!linked) symlinkSync(realAuthPath, authLink);
  } else {
    rmSync(path.join(home, "auth.json"), { force: true });
  }
  return home;
}
