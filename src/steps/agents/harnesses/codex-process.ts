import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { type GroupStopOutcome, stopProcessGroup, trackProcessGroup } from "./process-group.ts";

const SUPERVISOR = "jigs-codex-supervise.mjs";
const GROUPS = "jigs-codex-groups";

// Codex inherits this process's stdio, so the provider speaks JSON-RPC to
// Codex directly and nothing here relays or buffers it. Everything before the
// first await runs before any forwarded signal is handled, so a SIGTERM during
// startup still reaches the new group, and its id is on disk by then.
const SUPERVISOR_SOURCE = `import { spawn } from "node:child_process";
import { renameSync, writeFileSync } from "node:fs";
const [record, command, ...args] = process.argv.slice(2);
const child = spawn(command, args, { stdio: "inherit", detached: true });
if (child.pid !== undefined) {
  writeFileSync(record + ".tmp", String(child.pid));
  renameSync(record + ".tmp", record);
}
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"])
  process.on(signal, () => {
    try {
      process.kill(-child.pid, signal);
    } catch {}
  });
child.on("error", (error) => {
  process.stderr.write("jigs could not start Codex: " + error.message + "\\n");
  process.exit(127);
});
child.on("exit", (code, signal) => {
  if (signal === null) process.exit(code ?? 1);
  process.removeAllListeners(signal);
  process.kill(process.pid, signal);
});
`;

/** Where the launcher tells a Codex launch's supervisor to record its process group. */
export interface CodexSupervisor {
  script: string;
  groups: string;
}

/**
 * Write the supervisor the Codex launcher runs Codex under. It starts Codex as the leader of a new
 * process group, so jigs can stop the app server and the MCP servers it starts together.
 *
 * @remarks
 * The provider spawns the app server itself with no spawn hook, and its `close` signals only its
 * own child. Each launch records its group under `groups`, in a file named for the launch's pid:
 * empty while it starts, then the group id.
 */
export function writeCodexSupervisor(dir: string): CodexSupervisor {
  const script = path.join(dir, SUPERVISOR);
  const groups = path.join(dir, GROUPS);
  writeFileSync(script, SUPERVISOR_SOURCE, { mode: 0o600 });
  mkdirSync(groups, { recursive: true, mode: 0o700 });
  return { script, groups };
}

/** The Codex process groups one invocation has started, from {@link watchCodexProcessGroups}. */
export interface CodexProcessGroups {
  /** Stop every group started so far, waiting up to a second for a launch still starting. */
  stop(): Promise<GroupStopOutcome[]>;
  /** Stop, then stop watching. */
  close(): Promise<GroupStopOutcome[]>;
}

export interface CodexGroupTimings {
  pollMs: number;
  startupMs: number;
}

const TIMINGS: CodexGroupTimings = { pollMs: 100, startupMs: 1_000 };

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function recorded(file: string): string {
  try {
    return readFileSync(file, "utf8").trim();
  } catch {
    return "";
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref());

/**
 * Track each process group the supervisor records under `home`, as soon as it appears, so a stop
 * or service shutdown reaches it. `owner` names the groups in diagnostics.
 */
export function watchCodexProcessGroups(
  home: string,
  owner: string,
  timings: CodexGroupTimings = TIMINGS,
): CodexProcessGroups {
  const groups = path.join(home, GROUPS);
  // Launch pid to its group, or null for a launch that ended without one.
  // Settled launches are never read again, so a retired group id is never
  // tracked twice.
  const settled = new Map<number, number | null>();

  // The launches still starting.
  const scan = (): number[] => {
    let names: string[];
    try {
      names = readdirSync(groups);
    } catch {
      return [];
    }
    const starting: number[] = [];
    for (const name of names) {
      if (!/^\d+$/.test(name)) continue;
      const launch = Number(name);
      if (settled.has(launch)) continue;
      const file = path.join(groups, name);
      let pgid = recorded(file);
      if (pgid === "") {
        if (isAlive(launch)) {
          starting.push(launch);
          continue;
        }
        // It may have recorded its group just before exiting.
        pgid = recorded(file);
      }
      const id = pgid === "" ? null : Number(pgid);
      settled.set(launch, id);
      if (id !== null) trackProcessGroup(id, owner);
    }
    return starting;
  };

  const poll = setInterval(scan, timings.pollMs);
  poll.unref();

  const stop = async () => {
    const deadline = Date.now() + timings.startupMs;
    let starting = scan();
    while (starting.length > 0 && Date.now() < deadline) {
      await sleep(Math.min(20, timings.pollMs));
      starting = scan();
    }
    if (starting.length > 0)
      console.warn(
        `[jigs] ${owner}: ${starting.length} Codex launch(es) had not recorded a process group after ${timings.startupMs}ms; they cannot be stopped as a group`,
      );
    const ids = [...settled.values()].filter((id): id is number => id !== null);
    return Promise.all(ids.map((id) => stopProcessGroup(id)));
  };

  return {
    stop,
    close: async () => {
      try {
        return await stop();
      } finally {
        clearInterval(poll);
      }
    },
  };
}
