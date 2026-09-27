import { type ChildProcess, spawn } from "node:child_process";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { writeCodexLauncher } from "../drivers/codex-support.ts";
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

function groupIsGone(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return false;
  } catch {
    return true;
  }
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

test("a Codex killed by a signal Node ignores still fails the launcher", async () => {
  const codex = path.join(tmp, "codex");
  writeFileSync(codex, "#!/bin/sh\nkill -PIPE $$\n");
  chmodSync(codex, 0o755);
  const launcher = spawn(writeCodexLauncher(tmp, codex, ["PATH"]), [], {
    stdio: ["pipe", "pipe", "inherit"],
  });

  expect(await exited(launcher)).toEqual({ code: 141, signal: null });
});

test("a Codex that cannot start fails the launcher with 127", async () => {
  const launcher = spawn(writeCodexLauncher(tmp, path.join(tmp, "missing"), ["PATH"]), [], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  launcher.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  expect(await exited(launcher)).toEqual({ code: 127, signal: null });
  expect(stderr).toContain("ENOENT");
});

// Codex prints its pid, which is its group's id, then the pid of a child that
// ignores SIGTERM, as an MCP server might.
const CODEX_WITH_STUBBORN_CHILD = `const { spawn } = require("node:child_process");
const mcp = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); console.log('up'); setInterval(() => {}, 1e6)"], { stdio: ["ignore", "pipe", "ignore"] });
mcp.stdout.once("data", () => console.log(process.pid + " " + mcp.pid));
setInterval(() => {}, 1e6);`;

async function pidsOf(child: ChildProcess): Promise<[number, number]> {
  const line = await new Promise<string>((resolve) =>
    child.stdout?.setEncoding("utf8").once("data", resolve),
  );
  const [codex, mcp] = line.trim().split(" ").map(Number);
  return [codex as number, mcp as number];
}

test("a SIGTERM to the launcher stops Codex's whole group, TERM-ignoring children too", async () => {
  const launcher = spawn(
    writeCodexLauncher(tmp, fakeCodex(CODEX_WITH_STUBBORN_CHILD), ["PATH"]),
    [],
    {
      stdio: ["pipe", "pipe", "inherit"],
    },
  );
  const [codex] = await pidsOf(launcher);
  const exit = exited(launcher);
  launcher.kill("SIGTERM");

  expect(await exit).toEqual({ code: null, signal: "SIGTERM" });
  expect(groupIsGone(codex)).toBe(true);
});

test("a supervisor whose parent dies stops Codex's group", async () => {
  const launcher = writeCodexLauncher(tmp, fakeCodex(CODEX_WITH_STUBBORN_CHILD), ["PATH"]);
  // A parent that starts the launcher, reports the pids, then dies abruptly.
  const parent = spawn(
    process.execPath,
    [
      "-e",
      `const launcher = require("node:child_process").spawn(${JSON.stringify(launcher)}, [], { stdio: ["pipe", "pipe", "inherit"] });
launcher.stdout.once("data", (line) => { process.stdout.write(line); process.kill(process.pid, "SIGKILL"); });`,
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  const [codex, mcp] = await pidsOf(parent);
  await exited(parent);

  await expect.poll(() => groupIsGone(codex), { timeout: 5_000 }).toBe(true);
  expect(groupIsGone(mcp)).toBe(true);
});

test("a Codex that exits on its own takes its group's leftovers with it", async () => {
  const codex = fakeCodex(
    `const { spawn } = require("node:child_process");
const mcp = spawn(process.execPath, ["-e", "setInterval(() => {}, 1e6)"], { stdio: "ignore" });
console.log(process.pid + " " + mcp.pid);
setTimeout(() => process.exit(3), 100);`,
  );
  const launcher = spawn(writeCodexLauncher(tmp, codex, ["PATH"]), [], {
    stdio: ["pipe", "pipe", "inherit"],
  });
  const exit = exited(launcher);
  const [leader] = await pidsOf(launcher);

  expect(await exit).toEqual({ code: 3, signal: null });
  expect(groupIsGone(leader)).toBe(true);
});
