import { execFile } from "node:child_process";
import { promisify } from "node:util";
import semver from "semver";
import {
  resolveClaudeExecutable,
  resolveCodexExecutable,
} from "../steps/agent/harnesses/executables.ts";
import { DEFAULT_MIN_CODEX_VERSION } from "../steps/agent/harnesses/index.ts";
import { PROBE_TIMEOUT_MS } from "./catalog.ts";

// Are the harness CLIs installed, and is codex new enough? The service's
// startup gate and `jigs doctor` share this so they cannot disagree. The
// minimum comes from the codex provider; claude has none.

export type HarnessKind = "claude" | "codex";

/** `line` is the one line to show an operator, pass or fail. */
export type HarnessRuntime =
  | {
      harness: HarnessKind;
      path: string;
      version: string;
      minimum: string | null;
      ok: true;
      line: string;
    }
  | {
      harness: HarnessKind;
      path: string | null;
      version: string | null;
      minimum: string | null;
      ok: false;
      line: string;
      repair: string;
    };

export interface HarnessRuntimeDeps {
  resolve?: (harness: HarnessKind, env: NodeJS.ProcessEnv) => string;
  exec?: (
    file: string,
    args: string[],
    options: { timeout: number },
  ) => Promise<{ stdout: string; stderr: string }>;
  env?: NodeJS.ProcessEnv;
}

const execFileAsync = promisify(execFile);

// Said on every failure: a working `codex --version` in a terminal is what
// makes this easy to misread.
const PATH_CAVEAT =
  "service may not have the same PATH as your shell — start it from a shell where `claude` and `codex` both run";

const resolveDefault = (harness: HarnessKind, env: NodeJS.ProcessEnv): string =>
  harness === "claude" ? resolveClaudeExecutable(env) : resolveCodexExecutable(env);

export async function harnessRuntime(
  harness: HarnessKind,
  deps: HarnessRuntimeDeps = {},
): Promise<HarnessRuntime> {
  const resolve = deps.resolve ?? resolveDefault;
  const exec = deps.exec ?? execFileAsync;
  const env = deps.env ?? process.env;
  const minimum = harness === "codex" ? DEFAULT_MIN_CODEX_VERSION : null;
  const floor = minimum === null ? "" : ` (minimum ${minimum})`;
  const fail = (path: string | null, version: string | null, line: string): HarnessRuntime => ({
    harness,
    path,
    version,
    minimum,
    ok: false,
    line,
    repair: PATH_CAVEAT,
  });

  let path: string;
  try {
    path = resolve(harness, env);
  } catch {
    return fail(null, null, `${harness} not found on PATH${floor}`);
  }

  // Some CLIs print the version on stderr.
  let answer: string;
  try {
    const result = await exec(path, ["--version"], { timeout: PROBE_TIMEOUT_MS });
    answer = `${result.stdout}${result.stderr}`;
  } catch (err) {
    return fail(path, null, `\`${path} --version\` failed: ${err}${floor}`);
  }

  // coerce reads the version out of "codex-cli 0.153.4" and
  // "2.1.270 (Claude Code)" alike.
  const parsed = semver.coerce(answer, { includePrerelease: true });
  if (parsed === null) {
    return fail(
      path,
      null,
      `${path} answered no version to \`--version\`: ${answer.trim().slice(0, 80)}${floor}`,
    );
  }
  const version = parsed.version;
  if (minimum !== null && semver.lt(version, minimum)) {
    return fail(path, version, `${harness} ${version} at ${path} is below the minimum ${minimum}`);
  }
  return {
    harness,
    path,
    version,
    minimum,
    ok: true,
    line: `${harness} ${version} at ${path}${floor}`,
  };
}

export async function harnessRuntimes(
  kinds: HarnessKind[],
  deps: HarnessRuntimeDeps = {},
): Promise<HarnessRuntime[]> {
  return Promise.all([...new Set(kinds)].map((harness) => harnessRuntime(harness, deps)));
}
