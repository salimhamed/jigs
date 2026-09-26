import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
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
  /** Changes on every restart of the machine, and only then. */
  bootId(): string;
  /**
   * When `pid` started, in a form that stays the same for the life of the
   * process even if the wall clock is changed; undefined when there is no
   * such process.
   */
  startTime(pid: number): string | undefined;
}

// A fixed locale and time zone, so a start time read at stop matches the one
// recorded at start whatever the calling shell's environment.
const PS_ENV = { ...process.env, LC_ALL: "C", TZ: "UTC" };

/** {@link ProcessControl} for this machine, through `ps` and `process.kill`. */
export const systemProcesses: ProcessControl = {
  snapshot() {
    const result = spawnSync("ps", PS_ARGS, {
      encoding: "utf8",
      env: PS_ENV,
      maxBuffer: 64 * 1024 * 1024,
    });
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
  bootId() {
    if (process.platform === "linux") {
      return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    }
    if (process.platform === "darwin") {
      const result = spawnSync("sysctl", ["-n", "kern.bootsessionuuid"], { encoding: "utf8" });
      const uuid = result.status === 0 ? result.stdout.trim() : "";
      if (uuid !== "") return uuid;
      throw new JigsError(
        `could not read the boot session with sysctl -n kern.bootsessionuuid: ${result.error?.message ?? result.stderr}`,
      );
    }
    throw new JigsError(`jigs manages its service on macOS and Linux, not ${process.platform}`);
  },
  startTime(pid) {
    // Linux's lstart is computed from the wall-clock boot time and moves when
    // the clock is stepped; the kernel's tick count since boot does not.
    if (process.platform === "linux") {
      let stat: string;
      try {
        stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      } catch {
        return undefined;
      }
      return procStatStartTime(stat);
    }
    const result = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      env: PS_ENV,
    });
    const time = result.status === 0 ? normalize(result.stdout) : "";
    return time === "" ? undefined : time;
  },
};

const normalize = (text: string) => text.trim().replace(/\s+/g, " ");

/**
 * The start time field (22nd) of a Linux `/proc/<pid>/stat` line, in clock
 * ticks since boot. Fields are counted after the last `)`, since the command
 * name before it can hold spaces and parentheses.
 */
export function procStatStartTime(stat: string): string | undefined {
  const close = stat.lastIndexOf(")");
  if (close === -1) return undefined;
  // What follows `)` starts at field 3, the state.
  const field = stat
    .slice(close + 1)
    .trim()
    .split(/\s+/)[22 - 3];
  return field !== undefined && /^\d+$/.test(field) ? field : undefined;
}

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

/** What jigs records about the service it started, to know it again later. */
export interface ServiceRecord {
  /** The service's pid, which is also its process group ID. */
  processGroup: number;
  bootId: string;
  startTime: string;
  command: string;
}

/**
 * What a service record says about the processes running now.
 *
 * - `previous-boot`: the record is from before the machine restarted, so
 *   nothing it names is running. `lookalike` is a process that still matches
 *   the record's pid, start time and command, which should not happen.
 * - `service`: the recorded service is running.
 * - `leader-gone`: the service has exited and processes it started may remain
 *   in its group. A stop deletes the record once the group is empty, so this
 *   arises between a crash and the next start or stop; the group ID is not
 *   handed out again while anything is still in the group.
 * - `reused`: an unrelated process now has the service's pid, so the group
 *   is no longer the service's either.
 */
export type RecordVerdict =
  | { kind: "previous-boot"; lookalike?: ProcessEntry }
  | { kind: "service"; leader: ProcessEntry }
  | { kind: "leader-gone" }
  | { kind: "reused"; leader: ProcessEntry };

export function judgeRecord(
  record: ServiceRecord,
  observed: {
    bootId: string;
    entries: readonly ProcessEntry[];
    startTime: (pid: number) => string | undefined;
  },
): RecordVerdict {
  const leader = observed.entries.find((entry) => entry.pid === record.processGroup);
  const same =
    leader !== undefined &&
    normalize(leader.command) === normalize(record.command) &&
    observed.startTime(leader.pid) === record.startTime;
  if (record.bootId !== observed.bootId) {
    return same ? { kind: "previous-boot", lookalike: leader } : { kind: "previous-boot" };
  }
  if (leader === undefined) return { kind: "leader-gone" };
  return same ? { kind: "service", leader } : { kind: "reused", leader };
}

/**
 * What to stop. `servicePid` is set only for a service verified against its
 * record, and `processGroup` only while the group is still the service's.
 */
export interface ServiceTarget {
  servicePid?: number;
  processGroup?: number;
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
 * descendant of those, from one snapshot. Throws when the caller runs inside
 * the service or its group, since it could not stop the service without
 * stopping itself.
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
    const isService = entry.pid === target.servicePid;
    const inGroup = target.processGroup !== undefined && entry.pgid === target.processGroup;
    if ((isService || inGroup) && excluded.has(entry.pid)) {
      throw new JigsError(
        `refusing to stop the service from inside it: this command runs under pid ${entry.pid} (${entry.command})`,
        "run the command from a shell outside the factory's service",
      );
    }
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
  const live = { ...target };
  const known = new Map<number, string>();
  const denied = new Set<number>();
  const stopped = new Map<number, ProcessEntry>();
  const select = () => {
    const entries = parsePs(control.snapshot());
    // Once the service or its whole group has gone, a new process given the
    // same pid or group ID is someone else's.
    if (!entries.some((entry) => entry.pid === live.servicePid)) live.servicePid = undefined;
    if (!entries.some((entry) => entry.pgid === live.processGroup)) live.processGroup = undefined;
    return selectServiceProcesses(entries, live, { self, known });
  };
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

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
