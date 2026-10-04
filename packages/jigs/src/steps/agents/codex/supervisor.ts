import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const SUPERVISOR = "jigs-codex-supervise.mjs";
const GROUP_FILE = "jigs-codex.pgid";

// Codex inherits this process's stdio, so the provider speaks JSON-RPC to
// Codex directly and nothing here relays or buffers it. The provider's close
// signals only this process, and a service that dies signals nothing, so the
// supervisor stops Codex's whole group itself: on a signal, when its parent
// goes, or when Codex exits and leaves MCP servers behind. The handlers go on
// before Codex starts: without them a signal kills this process outright and
// orphans the new group. Node ignores or intercepts some signals, such as
// SIGPIPE and SIGUSR1, so a re-raise that does not end this process exits with
// the code a shell reports for that signal. It records Codex's group beside
// itself for the step to track, and removes the record once the group is gone.
const SUPERVISOR_SOURCE = `import { spawn } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { constants } from "node:os";
const [command, ...args] = process.argv.slice(2);
const groupFile = new URL(${JSON.stringify(GROUP_FILE)}, import.meta.url);
const parent = process.ppid;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let child;
let exited;
let stopping;
const signalGroup = (signal) => {
  try {
    process.kill(-child.pid, signal);
    return true;
  } catch {
    return false;
  }
};
const goneWithin = async (ms) => {
  const deadline = Date.now() + ms;
  while (signalGroup(0)) {
    if (Date.now() >= deadline) return false;
    await sleep(50);
  }
  return true;
};
const stop = () => {
  stopping ??= (async () => {
    if (child.pid !== undefined && signalGroup("SIGTERM") && !(await goneWithin(1000)) && signalGroup("SIGKILL"))
      await goneWithin(1000);
    rmSync(groupFile, { force: true });
    const [code, signal] = await exited;
    if (signal === null) process.exit(code ?? 1);
    process.removeAllListeners(signal);
    process.kill(process.pid, signal);
    setImmediate(() => process.exit(128 + constants.signals[signal]));
  })();
};
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, stop);
setInterval(() => {
  if (process.ppid !== parent) stop();
}, 500).unref();
child = spawn(command, args, { stdio: "inherit", detached: true });
if (child.pid !== undefined) writeFileSync(groupFile, String(child.pid));
exited = new Promise((resolve) => child.once("exit", (...status) => resolve(status)));
child.on("error", (error) => {
  process.stderr.write("jigs could not start Codex: " + error.message + "\\n");
  process.exit(127);
});
child.on("exit", stop);
`;

/**
 * Write the supervisor the Codex launcher runs Codex under, and return its path. It starts Codex
 * as the leader of a new process group and stops that group, with the MCP servers Codex started,
 * when it is signalled, loses its parent, or Codex exits.
 */
export function writeCodexSupervisor(dir: string): string {
  const script = path.join(dir, SUPERVISOR);
  writeFileSync(script, SUPERVISOR_SOURCE, { mode: 0o600 });
  return script;
}

/** The process group of the Codex the supervisor in `dir` started, while it is running. */
export function codexProcessGroup(dir: string): number | undefined {
  try {
    const pgid = Number(readFileSync(path.join(dir, GROUP_FILE), "utf8"));
    return Number.isInteger(pgid) && pgid > 1 ? pgid : undefined;
  } catch {
    return undefined;
  }
}
