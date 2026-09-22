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

test("Pi execution trusts a successful message_end rather than the child exit code", async () => {
  const bin = path.join(tmp, "bin");
  mkdirSync(bin);
  const executable = path.join(bin, "pi");
  writeFileSync(
    executable,
    [
      "#!/bin/sh",
      `printf '%s\\n' '${JSON.stringify({ type: "session", id: "session-child" })}'`,
      `printf '%s\\n' '${JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "finished" }],
          stopReason: "stop",
          usage: { input: 1, output: 1, totalTokens: 2, cost: { total: 0.1 } },
        },
      })}'`,
      "exit 9",
      "",
    ].join("\n"),
  );
  chmodSync(executable, 0o755);

  await expect(executePi({ args: [], cwd: tmp, env: { PATH: bin } })).resolves.toMatchObject({
    text: "finished",
    providerMetadata: { pi: { sessionId: "session-child" } },
  });
});
