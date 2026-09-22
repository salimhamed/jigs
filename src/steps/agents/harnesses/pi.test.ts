import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { executePi } from "./pi.ts";
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

test("Pi execution rejects a signal the process does not handle", async () => {
  const bin = writePi(["kill -KILL $$"]);

  await expect(executePi({ args: [], cwd: tmp, env: { PATH: bin } })).rejects.toThrow(
    "pi terminated by signal SIGKILL",
  );
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
