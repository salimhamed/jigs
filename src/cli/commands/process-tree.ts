import { spawnSync } from "node:child_process";
import { JigsError } from "../../errors.ts";

/** One row of a process snapshot. */
export interface ProcessEntry {
  pid: number;
  ppid: number;
  pgid: number;
  command: string;
}

/**
 * The `ps` arguments every snapshot uses. `-A`, `-ww` and these keywords mean
 * the same on macOS and Linux; `=` after each keyword drops the header line.
 */
export const PS_ARGS = ["-A", "-ww", "-o", "pid=,ppid=,pgid=,stat=,command="];

/** What stopping a process tree needs from the operating system. */
export interface ProcessControl {
  /** The output of `ps` run with {@link PS_ARGS}. */
  snapshot(): string;
  /** node's `kill(pid, sig)`: false when the process is gone, throws on any other error. */
  signal(pid: number, sig: NodeJS.Signals | 0): boolean;
}

/** {@link ProcessControl} for this machine, through `ps` and `process.kill`. */
export const systemProcesses: ProcessControl = {
  snapshot() {
    const result = spawnSync("ps", PS_ARGS, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    if (result.error !== undefined || result.status !== 0) {
      throw new JigsError(
        `could not list processes with ps ${PS_ARGS.join(" ")}: ${result.error?.message ?? result.stderr.trim()}`,
        "jigs needs ps to find what the service started; check that ps is on PATH",
      );
    }
    return result.stdout;
  },
  signal(pid, sig) {
    try {
      process.kill(pid, sig);
      return true;
    } catch (err) {
      // ESRCH is the only "gone" answer. Anything else — EPERM on a pid the
      // OS recycled to another user — is not a liveness verdict, so surface
      // it rather than report a process alive or dead on a guess.
      if ((err as NodeJS.ErrnoException).code === "ESRCH") return false;
      throw err;
    }
  },
};

const ROW = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s?(.*)$/;

/**
 * Parses `ps` output taken with {@link PS_ARGS}. Zombies are left out: they
 * have already exited and only wait for their parent to collect them.
 */
export function parsePs(output: string): ProcessEntry[] {
  const entries: ProcessEntry[] = [];
  for (const line of output.split("\n")) {
    const match = ROW.exec(line);
    if (match === null) continue;
    const [, pid, ppid, pgid, stat, command] = match;
    if (stat?.startsWith("Z")) continue;
    entries.push({
      pid: Number(pid),
      ppid: Number(ppid),
      pgid: Number(pgid),
      command: command?.trim() ?? "",
    });
  }
  return entries;
}

export interface ServiceTarget {
  servicePid: number;
  processGroup: number | undefined;
}

export interface SelectOptions {
  /** The process doing the selecting; it and its ancestors are never selected. */
  self: number;
  /**
   * Processes selected by an earlier snapshot. One whose parent has exited is
   * no longer a descendant of anything selected, so it is matched by pid and
   * command instead.
   */
  known?: ReadonlyMap<number, string>;
}

/**
 * Selects the service, every process in its process group, and every
 * descendant of those, from one snapshot. The service's own pid counts only
 * while it still leads the recorded group, so a pid the system gave to an
 * unrelated process is never selected.
 */
export function selectServiceProcesses(
  entries: readonly ProcessEntry[],
  target: ServiceTarget,
  options: SelectOptions,
): ProcessEntry[] {
  const byPid = new Map(entries.map((entry) => [entry.pid, entry]));
  const excluded = new Set<number>();
  for (let pid: number | undefined = options.self; pid !== undefined && pid > 0; ) {
    if (excluded.has(pid)) break;
    excluded.add(pid);
    pid = byPid.get(pid)?.ppid;
  }

  // An excluded ancestor still leads to its other children; the stopping
  // process itself leads only to its own helpers, such as ps.
  const reached = new Set<number>();
  for (const entry of entries) {
    const isService = entry.pid === target.servicePid && entry.pgid === target.processGroup;
    const inGroup = target.processGroup !== undefined && entry.pgid === target.processGroup;
    const isKnown = options.known?.get(entry.pid) === entry.command;
    if (isService || inGroup || isKnown) reached.add(entry.pid);
  }
  const children = new Map<number, ProcessEntry[]>();
  for (const entry of entries) {
    const siblings = children.get(entry.ppid) ?? [];
    siblings.push(entry);
    children.set(entry.ppid, siblings);
  }
  const queue = [...reached];
  for (let pid = queue.shift(); pid !== undefined; pid = queue.shift()) {
    if (pid === options.self) continue;
    for (const child of children.get(pid) ?? []) {
      if (reached.has(child.pid)) continue;
      reached.add(child.pid);
      queue.push(child.pid);
    }
  }
  const selected = entries.filter((entry) => reached.has(entry.pid) && !excluded.has(entry.pid));
  return selected.sort((a, b) => a.pid - b.pid);
}

export interface StopTreeOptions {
  /** How long everything gets to exit after SIGTERM before SIGKILL. */
  timeoutMs: number;
  pollMs: number;
  /** How long to wait for SIGKILL to take effect before the final snapshot. */
  killWaitMs: number;
  self?: number;
}

export interface StopTreeResult {
  /** Every process that was signalled. */
  stopped: ProcessEntry[];
  /** Those still running when SIGTERM's grace ran out. */
  killed: ProcessEntry[];
}

/**
 * Stops the service and everything it started: SIGTERM to every selected
 * process, repeated for newcomers until all have exited or the grace runs
 * out, then SIGKILL. Throws a JigsError naming every process still running
 * afterwards, including those the caller may not signal.
 */
export async function stopProcessTree(
  control: ProcessControl,
  target: ServiceTarget,
  options: StopTreeOptions,
): Promise<StopTreeResult> {
  const self = options.self ?? process.pid;
  const known = new Map<number, string>();
  const denied = new Set<number>();
  const stopped = new Map<number, ProcessEntry>();
  const select = () => selectServiceProcesses(parsePs(control.snapshot()), target, { self, known });
  const send = (entry: ProcessEntry, sig: NodeJS.Signals) => {
    known.set(entry.pid, entry.command);
    stopped.set(entry.pid, entry);
    try {
      control.signal(entry.pid, sig);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
      denied.add(entry.pid);
    }
  };
  const pending = (entries: ProcessEntry[]) => entries.filter((entry) => !denied.has(entry.pid));

  let current = select();
  const termDeadline = Date.now() + options.timeoutMs;
  for (;;) {
    for (const entry of current) if (!stopped.has(entry.pid)) send(entry, "SIGTERM");
    if (pending(current).length === 0 || Date.now() >= termDeadline) break;
    await sleep(options.pollMs);
    current = select();
  }

  const killed = pending(current);
  const killDeadline = Date.now() + options.killWaitMs;
  for (;;) {
    for (const entry of pending(current)) send(entry, "SIGKILL");
    if (pending(current).length === 0 || Date.now() >= killDeadline) break;
    await sleep(options.pollMs);
    current = select();
  }

  const survivors = select();
  if (survivors.length > 0) {
    throw new JigsError(
      [
        `${survivors.length} process(es) the service started are still running:`,
        ...survivors.map(
          (entry) =>
            `  pid ${entry.pid}${denied.has(entry.pid) ? " (not permitted to signal)" : ""}: ${entry.command}`,
        ),
      ].join("\n"),
      `end them yourself (kill -9 ${survivors.map((entry) => entry.pid).join(" ")}), then rerun the command`,
    );
  }
  return { stopped: [...stopped.values()], killed };
}

/** Processes in `processGroup`, other than the caller and its ancestors. */
export function processGroupMembers(
  entries: readonly ProcessEntry[],
  processGroup: number,
  self: number,
): ProcessEntry[] {
  return selectServiceProcesses(
    entries,
    { servicePid: processGroup, processGroup },
    { self },
  ).filter((entry) => entry.pgid === processGroup);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
