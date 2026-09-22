import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ClaudeCodeSettings, SpawnedProcess, SpawnOptions } from "ai-sdk-provider-claude-code";
import { scrubbedEnv } from "../harnesses/env.ts";
import { resolveClaudeExecutable } from "../harnesses/executables.ts";

export type ClaudeStepOptions = ClaudeCodeSettings & { cwd: string };

const STDERR_LIMIT = 4_000;

function spawnClaudeCode(options: SpawnOptions, env: Record<string, string>): SpawnedProcess {
  const child = spawn(options.command, options.args, {
    cwd: options.cwd,
    env,
    signal: options.signal,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const events = new EventEmitter();
  const stdout = new PassThrough();
  let stderr = "";
  let exitCode: number | null = null;
  let signalCode: NodeJS.Signals | null = null;
  let childExited = false;
  let stderrClosed = false;

  child.stdout.pipe(stdout, { end: false });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (data: string) => {
    stderr = `${stderr}${data}`.slice(-STDERR_LIMIT);
  });
  child.on("error", (error) => events.emit("error", error));

  const finish = () => {
    if (!childExited || !stderrClosed) return;
    const failed = !options.signal.aborted && (exitCode !== 0 || signalCode !== null);
    if (failed) {
      // The pinned SDK does not pass its stderr callback into a custom spawn
      // hook. Put the bounded stderr on the process failure so the provider's
      // existing classifier and capped-tail formatter still own the error.
      const message = stderr.trim()
        ? `Claude Code process failed. stderr: ${stderr.trim()}`
        : "Claude Code process failed";
      const error = Object.assign(new Error(message), { stderr });
      stdout.destroy(error);
      exitCode = 0;
      signalCode = null;
    } else {
      stdout.end();
    }
    setImmediate(() => events.emit("exit", exitCode, signalCode));
  };

  child.stderr.once("close", () => {
    stderrClosed = true;
    finish();
  });
  child.once("exit", (code, signal) => {
    exitCode = code;
    signalCode = signal;
    childExited = true;
    finish();
  });

  return {
    stdin: child.stdin,
    stdout,
    get killed() {
      return child.killed;
    },
    get exitCode() {
      return exitCode;
    },
    get signalCode() {
      return signalCode;
    },
    kill: child.kill.bind(child),
    on(event, listener) {
      events.on(event, listener);
    },
    once(event, listener) {
      events.once(event, listener);
    },
    off(event, listener) {
      events.off(event, listener);
    },
  };
}

export function claudeProcessSpawner(
  allowlist: readonly string[],
): NonNullable<ClaudeCodeSettings["spawnClaudeCodeProcess"]> {
  return (options: SpawnOptions): SpawnedProcess =>
    spawnClaudeCode(options, {
      ...scrubbedEnv(allowlist, options.env),
      // The SDK defaults this only when the provider-assembled environment
      // lacks it. Replace any inherited parent-session marker explicitly.
      CLAUDE_CODE_ENTRYPOINT: "sdk-ts",
    });
}

export function claudeStepSettings(
  options: ClaudeCodeSettings,
  envAllowlist: readonly string[],
): ClaudeCodeSettings {
  return {
    ...options,
    pathToClaudeCodeExecutable: options.pathToClaudeCodeExecutable ?? resolveClaudeExecutable(),
    spawnClaudeCodeProcess: claudeProcessSpawner(envAllowlist),
  };
}
