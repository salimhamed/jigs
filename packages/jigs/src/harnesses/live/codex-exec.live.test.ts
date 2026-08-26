import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { generateText } from "ai";
import { afterAll, beforeAll, expect, test } from "vitest";
import { codexExecStepSettings } from "../codex.ts";
import {
  ensureManagedCodexHome,
  managedCodexHomeState,
} from "../codex-home.ts";
import { stripApiCredentials } from "../env.ts";
import { codexExec } from "../index.ts";
import { makeTmpDir, removeTmpDir } from "../test-fixtures.ts";
import {
  assertLivePreconditions,
  makeScratchRepo,
  REAL_CODEX_AUTH,
} from "./fixtures/live-env.ts";

let tmp: string;
beforeAll(() => {
  assertLivePreconditions();
  stripApiCredentials();
  tmp = makeTmpDir();
});
afterAll(() => {
  removeTmpDir(tmp);
});

test("Codex exec smoke under the managed home; auth symlink and login survive", async () => {
  expect(process.env.OPENAI_API_KEY).toBeUndefined();
  const scratch = makeScratchRepo(tmp);
  const home = ensureManagedCodexHome(
    `live-exec-${crypto.randomUUID().slice(0, 8)}`,
    {
      baseDir: path.join(tmp, "codex-homes"),
    },
  );
  const codeword = `JIGS-LIVE-${crypto.randomUUID().slice(0, 8)}`;

  const model = codexExec(
    "gpt-5.5",
    codexExecStepSettings({
      cwd: scratch,
      codexHome: home,
      approvalMode: "never",
      sandboxMode: "workspace-write",
      reasoningEffort: "low",
    }),
  );
  await generateText({
    model,
    prompt: `Write a file live-probe.txt at the repo root containing exactly "${codeword}" on one line, then confirm what you wrote.`,
  });

  const probeFile = path.join(scratch, "live-probe.txt");
  expect(existsSync(probeFile)).toBe(true);
  expect(readFileSync(probeFile, "utf8").trim()).toBe(codeword);

  // The acceptance criterion: the auth symlink is intact and the real login
  // valid after a run.
  const state = managedCodexHomeState(home);
  expect(state.authIsSymlink).toBe(true);
  expect(state.authLinkTarget).toBe(REAL_CODEX_AUTH);
  const realAuth = JSON.parse(readFileSync(REAL_CODEX_AUTH, "utf8")) as Record<
    string,
    unknown
  >;
  expect(Object.keys(realAuth).length).toBeGreaterThan(0);
});
