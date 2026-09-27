import { type ChildProcess, spawn } from "node:child_process";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { writeCodexLauncher } from "../drivers/codex-support.ts";
import { watchCodexProcessGroups } from "./codex-process.ts";
import { isTrackedProcessGroup, stopProcessGroup } from "./process-group.ts";
import { makeTmpDir, removeTmpDir } from "./test-fixtures.ts";

let tmp: string;
beforeEach(() => {
  tmp = makeTmpDir();
});
afterEach(() => {
  removeTmpDir(tmp);
});

function fakeCodex(source: string): string {
  const codex = path.join(tmp, "codex");
  writeFileSync(codex, `#!${process.execPath}\n${source}`);
  chmodSync(codex, 0o755);
  return codex;
}

function exited(child: ChildProcess) {
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.once("exit", (code, signal) => resolve({ code, signal })),
  );
}

function recordOf(launcher: ChildProcess): string {
  return path.join(tmp, "jigs-codex-groups", String(launcher.pid));
}

test("the launcher passes stdio straight through and exits with Codex's code", async () => {
  const codex = fakeCodex(
    'process.stdin.pipe(process.stdout); process.stdin.on("end", () => process.exit(7));',
  );
  const launcher = spawn(writeCodexLauncher(tmp, codex, ["PATH"]), ["app-server"], {
    stdio: ["pipe", "pipe", "inherit"],
  });
  let output = "";
  launcher.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
    output += chunk;
  });
  const exit = exited(launcher);
  const lines = Array.from({ length: 2_000 }, (_, i) => `{"id":${i}}\n`).join("");
  launcher.stdin?.end(lines);

  expect(await exit).toEqual({ code: 7, signal: null });
  expect(output).toBe(lines);
  expect(Number(readFileSync(recordOf(launcher), "utf8"))).toBeGreaterThan(0);
});

test("a SIGTERM to the launcher reaches Codex, and the launcher ends as Codex did", async () => {
  const codex = fakeCodex(
    'process.on("SIGTERM", () => { require("node:fs").writeFileSync("termed", ""); process.exit(0); }); setInterval(() => {}, 1e6); console.log("up");',
  );
  const launcher = spawn(writeCodexLauncher(tmp, codex, ["PATH"]), [], {
    cwd: tmp,
    stdio: ["pipe", "pipe", "inherit"],
  });
  await new Promise((resolve) => launcher.stdout?.once("data", resolve));
  const exit = exited(launcher);
  launcher.kill("SIGTERM");

  expect(await exit).toEqual({ code: 0, signal: null });
  expect(readFileSync(path.join(tmp, "termed"), "utf8")).toBe("");
});

test("a launcher whose Codex dies by a signal dies by the same signal", async () => {
  const codex = fakeCodex('setInterval(() => {}, 1e6); console.log("up");');
  const launcher = spawn(writeCodexLauncher(tmp, codex, ["PATH"]), [], {
    stdio: ["pipe", "pipe", "inherit"],
  });
  await new Promise((resolve) => launcher.stdout?.once("data", resolve));
  const exit = exited(launcher);
  launcher.kill("SIGTERM");

  expect(await exit).toEqual({ code: null, signal: "SIGTERM" });
});

test("a Codex that cannot start leaves a group-less launch that stop does not wait on", async () => {
  const launcher = spawn(writeCodexLauncher(tmp, path.join(tmp, "missing"), ["PATH"]), [], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  launcher.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  expect(await exited(launcher)).toEqual({ code: 127, signal: null });
  expect(stderr).toContain("ENOENT");
  expect(readFileSync(recordOf(launcher), "utf8")).toBe("");

  const startedAt = Date.now();
  await expect(watchCodexProcessGroups(tmp, "Codex test").close()).resolves.toEqual([]);
  expect(Date.now() - startedAt).toBeLessThan(500);
});

// A stand-in for a launch caught between spawning Codex and recording it:
// its record stays empty until it spawns a group leader and writes its id.
test("stop waits for a launch still starting, then stops the group it records", async () => {
  writeCodexLauncher(tmp, "/unused", []);
  const groups = path.join(tmp, "jigs-codex-groups");
  const launch = spawn(
    process.execPath,
    [
      "-e",
      `const { spawn } = require("node:child_process");
const fs = require("node:fs");
const record = require("node:path").join(${JSON.stringify(groups)}, String(process.pid));
fs.writeFileSync(record, "");
process.stdout.write("ready\\n");
setTimeout(() => {
  const leader = spawn(process.execPath, ["-e", "setInterval(() => {}, 1e6)"], { detached: true, stdio: "ignore" });
  fs.writeFileSync(record, String(leader.pid));
  process.stdout.write(leader.pid + "\\n");
}, 300);
setInterval(() => {}, 1e6);`,
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  let output = "";
  launch.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
    output += chunk;
  });
  await expect.poll(() => output.startsWith("ready")).toBe(true);
  const watch = watchCodexProcessGroups(tmp, "Codex test");
  try {
    const [outcome] = await watch.stop();
    const leader = Number(output.split("\n")[1]);
    expect(outcome).toEqual({ kind: "stopped", pgid: leader });
    expect(isTrackedProcessGroup(leader)).toBe(false);
    expect(() => process.kill(-leader, 0)).toThrow();
    // A retired group is never tracked again from its old record.
    await watch.stop();
    expect(isTrackedProcessGroup(leader)).toBe(false);
  } finally {
    await watch.close();
    launch.kill("SIGKILL");
  }
});

test("a recorded group is tracked while the invocation runs, so shutdown reaches it", async () => {
  writeCodexLauncher(tmp, "/unused", []);
  const leader = spawn(process.execPath, ["-e", "setInterval(() => {}, 1e6)"], {
    detached: true,
    stdio: "ignore",
  });
  const pgid = leader.pid as number;
  writeFileSync(path.join(tmp, "jigs-codex-groups", String(process.pid)), String(pgid));
  const watch = watchCodexProcessGroups(tmp, "Codex test", { pollMs: 20, startupMs: 1_000 });
  try {
    await expect.poll(() => isTrackedProcessGroup(pgid)).toBe(true);
  } finally {
    await watch.close();
    await stopProcessGroup(pgid);
  }
  expect(isTrackedProcessGroup(pgid)).toBe(false);
});
