import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  isTrackedProcessGroup,
  type Signaller,
  stopProcessGroup,
  stopProcessGroups,
  trackProcessGroup,
} from "./process-group.ts";
import { makeTmpDir, removeTmpDir } from "./test-fixtures.ts";

let tmp: string;
const leftovers: number[] = [];
beforeEach(() => {
  tmp = makeTmpDir();
});
afterEach(() => {
  for (const pid of leftovers.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  vi.restoreAllMocks();
  removeTmpDir(tmp);
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const ignoreTerm = "process.on('SIGTERM', () => {});";

// A detached leader with one child in its group; resolves once both pids are known.
async function group(options: { ignoreTerm?: boolean } = {}): Promise<{
  leader: number;
  child: number;
}> {
  const pidFile = path.join(tmp, `child-${Math.random()}.pid`);
  const trap = options.ignoreTerm ? ignoreTerm : "";
  const childScript = `${trap} setInterval(() => {}, 1000);`;
  const leaderScript = `${trap}
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const child = spawn(process.execPath, ["-e", ${JSON.stringify(childScript)}], { stdio: "ignore" });
writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
setInterval(() => {}, 1000);`;
  const leader = spawn(process.execPath, ["-e", leaderScript], { detached: true, stdio: "ignore" });
  if (leader.pid === undefined) throw new Error("leader did not start");
  leftovers.push(leader.pid);
  await expect.poll(() => existsSync(pidFile)).toBe(true);
  const child = Number(readFileSync(pidFile, "utf8"));
  leftovers.push(child);
  // The traps are installed before the pid file is written, so they are live.
  return { leader: leader.pid, child };
}

test("SIGTERM stops a group and retires it", async () => {
  const { leader, child } = await group();
  trackProcessGroup(leader, "test group");

  await expect(stopProcessGroup(leader)).resolves.toEqual({ kind: "stopped", pgid: leader });

  expect(alive(leader)).toBe(false);
  expect(alive(child)).toBe(false);
  expect(isTrackedProcessGroup(leader)).toBe(false);
});

test("a group that ignores SIGTERM is killed after the grace period", async () => {
  const { leader, child } = await group({ ignoreTerm: true });
  trackProcessGroup(leader, "test group");
  const started = Date.now();

  await expect(stopProcessGroup(leader)).resolves.toEqual({ kind: "stopped", pgid: leader });

  expect(Date.now() - started).toBeGreaterThanOrEqual(1_000);
  expect(alive(leader)).toBe(false);
  expect(alive(child)).toBe(false);
});

test("concurrent stops and shutdown share one attempt", async () => {
  const { leader, child } = await group({ ignoreTerm: true });
  trackProcessGroup(leader, "test group");

  const first = stopProcessGroup(leader);
  const second = stopProcessGroup(leader);
  const shutdown = stopProcessGroups();

  expect(second).toBe(first);
  await expect(shutdown).resolves.toContainEqual({ kind: "stopped", pgid: leader });
  await expect(first).resolves.toEqual({ kind: "stopped", pgid: leader });
  expect(alive(leader)).toBe(false);
  expect(alive(child)).toBe(false);
});

test("a signal that cannot be delivered is reported and the group stays for shutdown", async () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const { leader, child } = await group();
  trackProcessGroup(leader, "Pi for run wrun_1");
  const refuse: Signaller = (pid, signal) => {
    if (signal === "SIGTERM")
      throw Object.assign(new Error("kill EPERM"), { code: "EPERM", errno: -1 });
    process.kill(pid, signal);
  };

  await expect(stopProcessGroup(leader, { kill: refuse })).resolves.toEqual({
    kind: "signal-failed",
    pgid: leader,
    reason: `sending SIGTERM to process group ${leader} failed: kill EPERM`,
  });
  expect(error).toHaveBeenCalledWith(expect.stringContaining(`[jigs] Pi for run wrun_1:`));
  expect(error).toHaveBeenCalledWith(expect.stringContaining(`process group ${leader}`));
  expect(alive(leader)).toBe(true);
  expect(isTrackedProcessGroup(leader)).toBe(true);

  await expect(stopProcessGroups()).resolves.toContainEqual({ kind: "stopped", pgid: leader });
  expect(alive(leader)).toBe(false);
  expect(alive(child)).toBe(false);
});

test("a group still visible after SIGKILL is reported unconfirmed and retired", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const pgid = 2_147_000_000;
  trackProcessGroup(pgid, "Pi for run wrun_2");
  const signals: (NodeJS.Signals | 0)[] = [];
  // Every probe finds the group, as it would a group of dying processes.
  const neverGone: Signaller = (_pid, signal) => {
    signals.push(signal);
  };

  await expect(
    stopProcessGroup(pgid, {
      kill: neverGone,
      timings: { graceMs: 20, postKillMs: 20, pollMs: 5 },
    }),
  ).resolves.toEqual({ kind: "not-confirmed", pgid });

  expect(signals.filter((signal) => signal !== 0)).toEqual(["SIGTERM", "SIGKILL"]);
  expect(warn).toHaveBeenCalledWith(
    `[jigs] Pi for run wrun_2: process group ${pgid} was still visible 20ms after SIGKILL; continuing cleanup`,
  );
  expect(isTrackedProcessGroup(pgid)).toBe(false);
});

test("an untracked or retired group is never signalled", async () => {
  const kill = vi.fn<Signaller>();

  await expect(stopProcessGroup(2_147_000_001, { kill })).resolves.toEqual({
    kind: "stopped",
    pgid: 2_147_000_001,
  });

  expect(kill).not.toHaveBeenCalled();
});

test("a tracked group that ends without a stop is retired, so its id is never signalled", async () => {
  const leader = spawn(process.execPath, ["-e", "setTimeout(() => {}, 50)"], {
    detached: true,
    stdio: "ignore",
  });
  const pgid = leader.pid as number;
  trackProcessGroup(pgid, "Pi for run wrun_3");
  await new Promise((resolve) => leader.once("exit", resolve));

  await expect.poll(() => isTrackedProcessGroup(pgid), { timeout: 3_000 }).toBe(false);
});
