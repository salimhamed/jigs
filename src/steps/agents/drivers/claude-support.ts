import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ClaudeCodeSettings, SpawnedProcess, SpawnOptions } from "ai-sdk-provider-claude-code";
import { resolveClaudeExecutable } from "../harnesses/executables.ts";
import { groupReaper, OWN_GROUP } from "../harnesses/process-group.ts";

const STDERR_LIMIT = 4_000;
// Once the group is gone, a pipe still held open by a process that left it is
// not waited on for longer than this, as the SDK itself does after an exit.
const STDIO_AFTER_REAP_MS = 200;
// Close gives a CLI still running this long to exit on its own, as the SDK
// does before it kills one.
const CLOSE_GRACE_MS = 2_000;

interface ClaudeLaunch {
  process: SpawnedProcess;
  /** Resolves once the exit has been reported to the SDK, or the launch failed. */
  reported: Promise<void>;
  stop(): void;
}

function spawnClaudeCode(
  options: SpawnOptions,
  env: Record<string, string>,
  owner: string,
  cancel: AbortSignal | undefined,
): ClaudeLaunch {
  const child = spawn(options.command, options.args, {
    cwd: options.cwd,
    env,
    // Claude Code's stdio MCP servers join its private group, so a stop
    // reaches them even when Claude itself cannot shut them down.
    detached: OWN_GROUP,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const reapGroup = groupReaper(child, owner);
  const events = new EventEmitter();
  const stdout = new PassThrough();
  let stderr = "";
  let exitCode: number | null = null;
  let signalCode: NodeJS.Signals | null = null;
  let childExited = false;
  let stdoutEnded = false;
  let stderrClosed = false;
  let stopRequested = false;
  let reaping = false;
  let reaped = false;
  let abandoned = false;
  let report!: () => void;
  const reported = new Promise<void>((resolve) => {
    report = resolve;
  });

  // Leader exit does not mean the group is gone, so every path stops it
  // before the exit is reported.
  const reap = () => {
    if (reaping) return;
    reaping = true;
    void reapGroup().then(() => {
      reaped = true;
      setTimeout(() => {
        abandoned = true;
        child.stdout.destroy();
        child.stderr.destroy();
        finish();
      }, STDIO_AFTER_REAP_MS);
      finish();
    });
  };
  const stop = () => {
    stopRequested = true;
    reap();
  };
  cancel?.addEventListener("abort", stop, { once: true });
  options.signal.addEventListener("abort", stop, { once: true });
  const detach = () => {
    cancel?.removeEventListener("abort", stop);
    options.signal.removeEventListener("abort", stop);
  };

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
  child.on("error", (error) => {
    events.emit("error", error);
    if (child.pid === undefined) {
      detach();
      report();
    }
  });

  let exitReported = false;
  const finish = () => {
    if (exitReported || !reaped) return;
    if (!abandoned && (!childExited || !stdoutEnded || !stderrClosed)) return;
    exitReported = true;
    detach();
    const code = childExited ? child.exitCode : null;
    const signal = childExited ? child.signalCode : null;
    const torndown = options.signal.aborted || stopRequested;
    const failed = !torndown && (code !== 0 || signal !== null);
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
      exitCode = code;
      signalCode = signal;
    }
    setImmediate(() => {
      events.emit("exit", exitCode, signalCode);
      report();
    });
  };

  child.stderr.once("close", () => {
    stderrClosed = true;
    finish();
  });
  child.once("exit", () => {
    childExited = true;
    reap();
    finish();
  });
  if (cancel?.aborted || options.signal.aborted) stop();

  return {
    reported,
    stop,
    process: {
      stdin: child.stdin,
      stdout,
      get killed() {
        return child.killed || stopRequested;
      },
      // Both stay null until the exit is reported, so the SDK waits for it.
      get exitCode() {
        return exitCode;
      },
      get signalCode() {
        return signalCode;
      },
      // The SDK tears a lingering CLI down through this after a normal result.
      kill() {
        stop();
        return true;
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
    },
  };
}

// Where Claude Code keeps its login when it is not under ~/.claude.
export const CLAUDE_ENV = ["CLAUDE_CONFIG_DIR"];

/** A Claude Code launch hook that also knows the processes it started. */
export type ClaudeProcessSpawner = NonNullable<ClaudeCodeSettings["spawnClaudeCodeProcess"]> & {
  /**
   * Resolve once every Claude Code this hook started has exited and its process group is
   * stopped. One still running after a short grace is stopped.
   */
  close(): Promise<void>;
};

export interface ClaudeLaunchOptions {
  /** Stops every Claude Code this hook started, with its process group, when it aborts. */
  signal?: AbortSignal;
  /** Names the launch in stop diagnostics, such as `Claude Code for run wrun_123`. */
  owner?: string;
  host?: NodeJS.ProcessEnv;
}

function exitedWithin(launch: ClaudeLaunch, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    timer.unref();
    void launch.reported.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

// The provider rebuilds the child environment from the host (every
// ANTHROPIC_*, CLAUDE_*, AWS_* and GOOGLE_* variable among others), so the
// launch hook replaces it with the step's own. What the SDK itself added, the
// keys the host does not have, is kept; the SDK also writes its version marker
// into the host, so that prefix is kept by name.
export function claudeProcessSpawner(
  env: Record<string, string>,
  options: ClaudeLaunchOptions = {},
): ClaudeProcessSpawner {
  const { signal, owner = "Claude Code", host = process.env } = options;
  const live = new Set<ClaudeLaunch>();
  const spawnHook = (spawnOptions: SpawnOptions): SpawnedProcess => {
    const sdkAdded = Object.entries(spawnOptions.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined &&
        !(entry[0] in env) &&
        (!(entry[0] in host) || entry[0].startsWith("CLAUDE_AGENT_SDK_")),
    );
    const launch = spawnClaudeCode(
      spawnOptions,
      {
        ...Object.fromEntries(sdkAdded),
        ...env,
        // Replaces any inherited parent-session marker.
        CLAUDE_CODE_ENTRYPOINT: "sdk-ts",
      },
      owner,
      signal,
    );
    live.add(launch);
    void launch.reported.then(() => live.delete(launch));
    return launch.process;
  };
  const close = async () => {
    await Promise.all(
      [...live].map(async (launch) => {
        if (await exitedWithin(launch, CLOSE_GRACE_MS)) return;
        launch.stop();
        await launch.reported;
      }),
    );
  };
  return Object.assign(spawnHook, { close });
}

/**
 * Claude Code settings for one step: the step's environment, and a launch hook that runs Claude
 * in its own process group and stops that group when `signal` aborts. Call the hook's `close`
 * once the model is done.
 */
export function claudeStepSettings(
  options: ClaudeCodeSettings & { env: Record<string, string> } & Omit<ClaudeLaunchOptions, "host">,
): ClaudeCodeSettings & { spawnClaudeCodeProcess: ClaudeProcessSpawner } {
  const { signal, owner, ...settings } = options;
  return {
    ...settings,
    pathToClaudeCodeExecutable: settings.pathToClaudeCodeExecutable ?? resolveClaudeExecutable(),
    spawnClaudeCodeProcess: claudeProcessSpawner(settings.env, {
      ...(signal === undefined ? {} : { signal }),
      ...(owner === undefined ? {} : { owner }),
    }),
  };
}
