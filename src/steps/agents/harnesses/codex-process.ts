import { writeFileSync } from "node:fs";
import path from "node:path";

// Codex inherits this process's stdio, so the provider speaks JSON-RPC to
// Codex directly and nothing here relays or buffers it. The provider's close
// signals only this process, and a service that dies signals nothing, so the
// supervisor stops Codex's whole group itself: on a signal, when its parent
// goes, or when Codex exits and leaves MCP servers behind. The handlers go on
// before Codex starts: without them a signal kills this process outright and
// orphans the new group. Node ignores or intercepts some signals, such as
// SIGPIPE and SIGUSR1, so a re-raise that does not end this process exits with
// the code a shell reports for that signal.
const SUPERVISOR_SOURCE = `import { spawn } from "node:child_process";
import { constants } from "node:os";
const [command, ...args] = process.argv.slice(2);
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
  const script = path.join(dir, "jigs-codex-supervise.mjs");
  writeFileSync(script, SUPERVISOR_SOURCE, { mode: 0o600 });
  return script;
}
