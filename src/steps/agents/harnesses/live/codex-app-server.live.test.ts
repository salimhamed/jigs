import { execFile } from "node:child_process";
import { existsSync, globSync, readFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, test } from "vitest";
import { stripApiCredentials } from "../env.ts";
import { makeTmpDir, removeTmpDir } from "../test-fixtures.ts";
import { assertLivePreconditions, makeManagedHome, makeScratchRepo } from "./fixtures/live-env.ts";

const execFileAsync = promisify(execFile);

let tmp: string;
beforeAll(() => {
  assertLivePreconditions();
  tmp = makeTmpDir();
});
afterAll(() => {
  removeTmpDir(tmp);
});

// The clean-exit acceptance criterion, tested honestly as a subprocess: the
// child runs one app-server step via withCodexAppServer and must exit 0
// within the deadline. A leaked client pool fails the deadline, not vitest.
test("app-server step: persistent thread, rollout under the managed home, clean exit", async () => {
  const scratch = makeScratchRepo(tmp);
  const home = makeManagedHome(tmp, "live-appserver");
  const fixture = path.join(import.meta.dirname, "fixtures", "app-server-step.ts");
  const resultFile = path.join(tmp, "app-server-result.json");

  const childEnv = { ...process.env };
  stripApiCredentials(childEnv);
  await execFileAsync("node", [fixture, scratch, home, resultFile], {
    env: childEnv,
    timeout: 480_000,
    killSignal: "SIGKILL",
  });

  const result = JSON.parse(readFileSync(resultFile, "utf8")) as {
    text: string;
    threadId?: string;
  };
  expect(result.text).toContain("ACK");
  expect(result.threadId).toBeTruthy();

  // The invocation home's sessions link targets the durable per-run store
  // (only persistent threads write a rollout).
  const rollouts = globSync(path.join(home, "sessions", "**", `*${result.threadId}*`));
  expect(rollouts.length).toBeGreaterThan(0);
  expect(existsSync(path.join(home, "auth.json"))).toBe(true);
});
