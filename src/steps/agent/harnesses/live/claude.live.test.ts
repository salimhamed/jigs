import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { generateText } from "ai";
import { afterAll, beforeAll, expect, test } from "vitest";
import { claudeStepSettings } from "../claude.ts";
import { stripApiCredentials } from "../env.ts";
import { claudeCode } from "../index.ts";
import { makeTmpDir, removeTmpDir } from "../test-fixtures.ts";
import {
  assertLivePreconditions,
  makeScratchRepo,
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

test("Claude Code smoke: subscription auth drives an agentic step, no API keys", async () => {
  expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
  const scratch = makeScratchRepo(tmp);
  const codeword = `JIGS-LIVE-${crypto.randomUUID().slice(0, 8)}`;

  const model = claudeCode("sonnet", claudeStepSettings({ cwd: scratch }));
  const result = await generateText({
    model,
    prompt: `Write a file live-probe.txt at the repo root containing exactly "${codeword}" on one line, then confirm what you wrote.`,
  });

  const probeFile = path.join(scratch, "live-probe.txt");
  expect(existsSync(probeFile)).toBe(true);
  expect(readFileSync(probeFile, "utf8").trim()).toBe(codeword);

  const meta = result.providerMetadata?.["claude-code"] as
    | { sessionId?: string }
    | undefined;
  expect(meta?.sessionId).toBeTruthy();
});
