import { execFile } from "node:child_process";
import { promisify } from "node:util";
import semver from "semver";
import { PROBE_TIMEOUT_MS } from "../../../checks/catalog.ts";
import type { Check, CheckResult } from "../../../checks/check.ts";
import type { HarnessKind } from "../../../workflow/agents/harness-config.ts";
import { factoryAgentEnv, harnessEnv } from "../harnesses/env.ts";

// Are the harness CLIs installed, and new enough? The service's startup gate
// and `jigs doctor` share this so they cannot disagree.

/** The installed CLI a harness driver runs. */
export interface HarnessCli<K extends HarnessKind = HarnessKind> {
  kind: K;
  displayName: string;
  resolveExecutable?(env: NodeJS.ProcessEnv): string;
  minimumVersion?: string;
}

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
  resolve?: (env: NodeJS.ProcessEnv) => string;
  exec?: (
    file: string,
    args: string[],
    options: { env: Record<string, string>; timeout: number },
  ) => Promise<{ stdout: string; stderr: string }>;
  env?: NodeJS.ProcessEnv;
  factoryEnv?: () => readonly string[];
}

const execFileAsync = promisify(execFile);

// Said on every failure: a working `codex --version` in a terminal is what
// makes this easy to misread.
const PATH_CAVEAT =
  "the service may not have your shell's PATH\nstart it from a shell where each required harness runs";

export async function harnessRuntime(
  cli: HarnessCli,
  deps: HarnessRuntimeDeps = {},
): Promise<HarnessRuntime> {
  const harness = cli.kind;
  const resolve = deps.resolve ?? cli.resolveExecutable;
  const exec = deps.exec ?? execFileAsync;
  const env = deps.env ?? process.env;
  const minimum = cli.minimumVersion ?? null;
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
    if (resolve === undefined) throw new Error(`no runtime resolver for ${harness}`);
    path = resolve(env);
  } catch {
    return fail(null, null, `${harness} not found on PATH${floor}`);
  }

  // Under the agent environment, so a CLI that needs an undeclared variable
  // fails here rather than in a step. Some CLIs print the version on stderr.
  const probeEnv = harnessEnv((deps.factoryEnv ?? factoryAgentEnv)(), env);
  let answer: string;
  try {
    const result = await exec(path, ["--version"], { env: probeEnv, timeout: PROBE_TIMEOUT_MS });
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

/** The same check the service gates its boot on, so doctor cannot pass
 *  something the service would refuse. */
export function harnessRuntimeCheck(cli: HarnessCli, deps: HarnessRuntimeDeps = {}): Check {
  return {
    id: `harness.${cli.kind}-cli`,
    label: `${cli.displayName} CLI`,
    run: async (): Promise<CheckResult> => {
      const runtime = await harnessRuntime(cli, deps);
      return runtime.ok
        ? { ok: true, detail: runtime.line }
        : { ok: false, reason: runtime.line, repair: runtime.repair };
    },
  };
}
