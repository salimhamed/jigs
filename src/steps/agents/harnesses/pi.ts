import { spawn } from "node:child_process";
import type { ExecutorGeneration } from "../drivers/types.ts";
import { resolvePiExecutable } from "./executables.ts";
import { type PiReduceOptions, reducePiJsonl } from "./pi-jsonl.ts";

export type PiExecutionOptions = PiReduceOptions & {
  args: string[];
  cwd: string;
  env: Record<string, string>;
  signal?: AbortSignal;
};

const FORCE_KILL_DELAY_MS = 1_000;
const GROUP_POLL_MS = 50;

type PiProcessGroups = { groups: Map<number, Promise<void> | null>; exitHook: boolean };

// Keyed on globalThis because the service and a factory's step bundle can each
// load their own copy of this module, and shutdown must see every live group.
const REGISTRY = Symbol.for("jigs.pi.processGroups");

function processGroups(): PiProcessGroups {
  const holder = globalThis as { [REGISTRY]?: PiProcessGroups };
  holder[REGISTRY] ??= { groups: new Map(), exitHook: false };
  return holder[REGISTRY];
}

function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

function signalGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal);
  } catch {
    // The group already exited.
  }
}

function trackGroup(pgid: number): void {
  const registry = processGroups();
  registry.groups.set(pgid, null);
  if (registry.exitHook) return;
  registry.exitHook = true;
  // Pi runs in its own process group, so a signal or crash that ends this
  // process no longer reaches it. `exit` handlers cannot wait, so kill outright.
  process.on("exit", () => {
    for (const group of registry.groups.keys()) signalGroup(group, "SIGKILL");
  });
}

// The SIGKILL is sent only after checking the group still exists, so a group
// that is gone (and whose id could be reused) is never signalled again.
function stopGroup(pgid: number): Promise<void> {
  const { groups } = processGroups();
  const pending = groups.get(pgid);
  if (pending) return pending;
  if (!groupAlive(pgid)) {
    groups.delete(pgid);
    return Promise.resolve();
  }
  signalGroup(pgid, "SIGTERM");
  const stopping = new Promise<void>((resolve) => {
    const deadline = Date.now() + FORCE_KILL_DELAY_MS;
    const poll = setInterval(() => {
      if (groupAlive(pgid)) {
        if (Date.now() < deadline) return;
        signalGroup(pgid, "SIGKILL");
      }
      clearInterval(poll);
      groups.delete(pgid);
      resolve();
    }, GROUP_POLL_MS);
    poll.unref();
  });
  groups.set(pgid, stopping);
  return stopping;
}

/**
 * Stop every Pi process group this process started: SIGTERM, then SIGKILL
 * whatever is left after a short grace period.
 */
export async function stopPiProcesses(): Promise<void> {
  await Promise.all([...processGroups().groups.keys()].map(stopGroup));
}

/** Execute one Pi JSON-mode turn and reduce its event stream. */
export function executePi(options: PiExecutionOptions): Promise<ExecutorGeneration> {
  if (options.signal?.aborted)
    return Promise.reject(options.signal.reason ?? new Error("Pi execution was aborted"));
  return new Promise((resolve, reject) => {
    const grouped = process.platform !== "win32";
    const child = spawn(resolvePiExecutable(options.env), options.args, {
      cwd: options.cwd,
      env: options.env,
      // A private process group lets jigs reap adapter-owned MCP descendants
      // even when Pi itself is killed before the adapter can dispose them.
      detached: grouped,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (grouped && child.pid !== undefined) trackGroup(child.pid);
    const terminateTree = () => {
      const pid = child.pid;
      if (pid === undefined) return;
      if (grouped) void stopGroup(pid);
      else child.kill("SIGTERM");
    };
    options.signal?.addEventListener("abort", terminateTree, { once: true });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      options.signal?.removeEventListener("abort", terminateTree);
      terminateTree();
      reject(error);
    });
    // `close` waits for inherited stdio handles. Reap the process group as
    // soon as its leader exits so an orphan cannot keep those handles open.
    child.once("exit", terminateTree);
    child.once("close", (code, signal) => {
      options.signal?.removeEventListener("abort", terminateTree);
      terminateTree();
      try {
        if (options.signal?.aborted)
          throw options.signal.reason ?? new Error("Pi execution was aborted");
        if (signal !== null) throw new Error(`pi terminated by signal ${signal}`);
        if (code === 143) throw new Error("pi was cancelled by SIGTERM (exit code 143)");
        if (code === 129) throw new Error("pi was cancelled by SIGHUP (exit code 129)");
        if (code !== 0) throw new Error(`pi exited with code ${code ?? "unknown"}`);
        resolve(reducePiJsonl(stdout, options));
      } catch (error) {
        reject(
          stderr.trim() === ""
            ? error
            : new Error(
                `${error instanceof Error ? error.message : String(error)}: ${stderr.trim()}`,
              ),
        );
      }
    });
  });
}
