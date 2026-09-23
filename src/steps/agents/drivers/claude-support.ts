import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ClaudeCodeSettings, SpawnedProcess, SpawnOptions } from "ai-sdk-provider-claude-code";
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
  let stdoutEnded = false;
  let stderrClosed = false;
  let killedByCaller = false;

  // The SDK closes its reader after the result message, so a failure that
  // lands on this stream afterwards has no listener. Keep it from becoming an
  // uncaught exception; the SDK's own listener still sees it while reading.
  stdout.on("error", () => {});
  // Forward without pipe backpressure so the child's stdout always drains and
  // ends, even once the SDK has stopped reading.
  child.stdout.on("data", (chunk: Buffer) => {
    stdout.write(chunk);
  });
  child.stdout.once("end", () => {
    stdoutEnded = true;
    finish();
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (data: string) => {
    stderr = `${stderr}${data}`.slice(-STDERR_LIMIT);
  });
  child.on("error", (error) => events.emit("error", error));

  const finish = () => {
    if (!childExited || !stdoutEnded || !stderrClosed) return;
    const torndown = options.signal.aborted || killedByCaller;
    const failed = !torndown && (exitCode !== 0 || signalCode !== null);
    if (failed) {
      // The pinned SDK does not pass its stderr callback into a custom spawn
      // hook. Put the bounded stderr on the process failure so the provider's
      // existing classifier and capped-tail formatter still own the error.
      const message = stderr.trim()
        ? `Claude Code process failed. stderr: ${stderr.trim()}`
        : "Claude Code process failed";
      const error = Object.assign(new Error(message), { stderr });
      stdout.destroy(error);
      // Report a clean exit so the SDK does not raise its own stderr-less
      // exit error ahead of the one carrying the diagnostics.
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
    // The SDK tears a lingering CLI down through this after a normal result.
    kill(signal) {
      killedByCaller = true;
      return child.kill(signal);
    },
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

// Where Claude Code keeps its login when it is not under ~/.claude.
export const CLAUDE_ENV = ["CLAUDE_CONFIG_DIR"];

// The provider rebuilds the child environment from the host (every
// ANTHROPIC_*, CLAUDE_*, AWS_* and GOOGLE_* variable among others), so the
// launch hook replaces it with the step's own. What the SDK itself added, the
// keys the host does not have, is kept; the SDK also writes its version marker
// into the host, so that prefix is kept by name.
export function claudeProcessSpawner(
  env: Record<string, string>,
  host: NodeJS.ProcessEnv = process.env,
): NonNullable<ClaudeCodeSettings["spawnClaudeCodeProcess"]> {
  return (options: SpawnOptions): SpawnedProcess => {
    const sdkAdded = Object.entries(options.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined &&
        !(entry[0] in env) &&
        (!(entry[0] in host) || entry[0].startsWith("CLAUDE_AGENT_SDK_")),
    );
    return spawnClaudeCode(options, {
      ...Object.fromEntries(sdkAdded),
      ...env,
      // Replaces any inherited parent-session marker.
      CLAUDE_CODE_ENTRYPOINT: "sdk-ts",
    });
  };
}

export function claudeStepSettings(
  options: ClaudeCodeSettings & { env: Record<string, string> },
): ClaudeCodeSettings {
  return {
    ...options,
    pathToClaudeCodeExecutable: options.pathToClaudeCodeExecutable ?? resolveClaudeExecutable(),
    spawnClaudeCodeProcess: claudeProcessSpawner(options.env),
  };
}
