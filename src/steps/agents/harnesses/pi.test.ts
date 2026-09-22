import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, expect, test } from "vitest";
import { executePi, stopPiProcesses } from "./pi.ts";
import { makeTmpDir, removeTmpDir } from "./test-fixtures.ts";

let tmp: string;
beforeEach(() => {
  tmp = makeTmpDir();
});
afterEach(() => removeTmpDir(tmp));

function writePi(lines: string[]): string {
  const bin = path.join(tmp, "bin");
  mkdirSync(bin);
  const executable = path.join(bin, "pi");
  writeFileSync(executable, ["#!/bin/sh", ...lines, ""].join("\n"));
  chmodSync(executable, 0o755);
  return bin;
}

function pidIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const descendant = `'${process.execPath}' -e 'setTimeout(() => {}, 60000)'`;

const event = (value: unknown): string => `printf '%s\\n' '${JSON.stringify(value)}'`;

const successEvents = [
  event({ type: "session", id: "session-child" }),
  event({ type: "agent_start" }),
  event({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "finished" }],
      stopReason: "stop",
    },
  }),
  event({ type: "agent_end", messages: [], willRetry: false }),
  event({ type: "agent_settled" }),
];

test("Pi execution requires settlement and a normal successful close", async () => {
  const bin = writePi([...successEvents, "exit 0"]);

  await expect(executePi({ args: [], cwd: tmp, env: { PATH: bin } })).resolves.toMatchObject({
    text: "finished",
    providerMetadata: { pi: { sessionId: "session-child" } },
  });
});

test("Pi execution rejects a nonzero exit after a settled response", async () => {
  const bin = writePi([...successEvents, "printf '%s\\n' 'transport failed' >&2", "exit 9"]);

  await expect(executePi({ args: [], cwd: tmp, env: { PATH: bin } })).rejects.toThrow(
    "pi exited with code 9: transport failed",
  );
});

test("Pi execution rejects a process failure after an accepted submit_result", async () => {
  const bin = writePi([
    event({ type: "agent_start" }),
    event({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "submit", name: "submit_result", arguments: {} }],
        stopReason: "toolUse",
      },
    }),
    event({
      type: "tool_execution_end",
      toolName: "submit_result",
      result: { content: [], details: { ok: true } },
      isError: false,
    }),
    event({ type: "agent_settled" }),
    "exit 9",
  ]);

  await expect(
    executePi({ args: [], cwd: tmp, env: { PATH: bin }, requireResult: true }),
  ).rejects.toThrow("pi exited with code 9");
});

test("Pi execution rejects a signal the process does not handle", async () => {
  const bin = writePi(["kill -KILL $$"]);

  await expect(executePi({ args: [], cwd: tmp, env: { PATH: bin } })).rejects.toThrow(
    "pi terminated by signal SIGKILL",
  );
});

test("Pi execution abort terminates Pi and its descendants", async () => {
  const piPidFile = path.join(tmp, "pi.pid");
  const descendantPidFile = path.join(tmp, "descendant.pid");
  const bin = writePi([
    `printf '%s' "$$" > '${piPidFile}'`,
    `${descendant} &`,
    `printf '%s' "$!" > '${descendantPidFile}'`,
    "wait",
  ]);
  const controller = new AbortController();
  const execution = executePi({
    args: [],
    cwd: tmp,
    env: { PATH: bin },
    signal: controller.signal,
  });
  const rejection = expect(execution).rejects.toThrow("cancelled by jigs");
  await expect.poll(() => existsSync(descendantPidFile)).toBe(true);

  controller.abort(new Error("cancelled by jigs"));

  await rejection;
  const piPid = Number(readFileSync(piPidFile, "utf8"));
  const descendantPid = Number(readFileSync(descendantPidFile, "utf8"));
  await expect.poll(() => pidIsRunning(piPid), { timeout: 2_000 }).toBe(false);
  await expect.poll(() => pidIsRunning(descendantPid), { timeout: 2_000 }).toBe(false);
});

test("Pi execution reaps descendants after Pi is killed", async () => {
  const piPidFile = path.join(tmp, "killed-pi.pid");
  const descendantPidFile = path.join(tmp, "killed-descendant.pid");
  const bin = writePi([
    `printf '%s' "$$" > '${piPidFile}'`,
    `${descendant} &`,
    `printf '%s' "$!" > '${descendantPidFile}'`,
    "wait",
  ]);
  const execution = executePi({ args: [], cwd: tmp, env: { PATH: bin } });
  const rejection = expect(execution).rejects.toThrow("pi terminated by signal SIGKILL");
  await expect.poll(() => existsSync(descendantPidFile)).toBe(true);

  process.kill(Number(readFileSync(piPidFile, "utf8")), "SIGKILL");

  await rejection;
  const descendantPid = Number(readFileSync(descendantPidFile, "utf8"));
  await expect.poll(() => pidIsRunning(descendantPid), { timeout: 2_000 }).toBe(false);
});

test("stopping Pi processes terminates every live Pi and its descendants", async () => {
  const descendantPidFile = path.join(tmp, "stopped-descendant.pid");
  const bin = writePi([`${descendant} &`, `printf '%s' "$!" > '${descendantPidFile}'`, "wait"]);
  const execution = executePi({ args: [], cwd: tmp, env: { PATH: bin } });
  const rejection = expect(execution).rejects.toThrow("pi terminated by signal SIGTERM");
  await expect.poll(() => existsSync(descendantPidFile)).toBe(true);

  await stopPiProcesses();

  await rejection;
  expect(pidIsRunning(Number(readFileSync(descendantPidFile, "utf8")))).toBe(false);
});

test("Pi processes do not outlive the process that started them", async () => {
  const descendantPidFile = path.join(tmp, "orphan-descendant.pid");
  const bin = writePi([`${descendant} &`, `printf '%s' "$!" > '${descendantPidFile}'`, "wait"]);
  const script = path.join(tmp, "host.mjs");
  writeFileSync(
    script,
    `import { existsSync } from "node:fs";
import { executePi } from ${JSON.stringify(pathToFileURL(path.join(import.meta.dirname, "pi.ts")).href)};
executePi({ args: [], cwd: ${JSON.stringify(tmp)}, env: { PATH: ${JSON.stringify(bin)} } }).catch(() => {});
setInterval(() => {
  if (existsSync(${JSON.stringify(descendantPidFile)})) process.exit(0);
}, 20);
`,
  );
  const host = spawn(process.execPath, [script], { stdio: "ignore" });
  const [code] = (await once(host, "exit")) as [number | null];
  expect(code).toBe(0);

  const descendantPid = Number(readFileSync(descendantPidFile, "utf8"));
  await expect.poll(() => pidIsRunning(descendantPid), { timeout: 2_000 }).toBe(false);
});

test.each([
  [143, "SIGTERM"],
  [129, "SIGHUP"],
])("Pi execution translates handled cancellation exit %i", async (code, signal) => {
  const bin = writePi([`exit ${code}`]);

  await expect(executePi({ args: [], cwd: tmp, env: { PATH: bin } })).rejects.toThrow(
    `pi was cancelled by ${signal} (exit code ${code})`,
  );
});

test("Pi execution rejects a crash after an intermediate assistant response", async () => {
  const bin = writePi([...successEvents.slice(0, 3), "exit 7"]);

  await expect(executePi({ args: [], cwd: tmp, env: { PATH: bin } })).rejects.toThrow(
    "pi exited with code 7",
  );
});

test("Pi execution rejects a malformed successful stream", async () => {
  const bin = writePi([
    "printf '%s' '{\"type\":\"agent_start\"}'",
    "printf '%s' '{broken'",
    "exit 0",
  ]);

  await expect(executePi({ args: [], cwd: tmp, env: { PATH: bin } })).rejects.toThrow(
    "invalid JSON event on line 1",
  );
});
