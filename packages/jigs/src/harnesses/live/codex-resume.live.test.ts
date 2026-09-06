import path from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { claude, codex } from "../../steps/config.ts";
import { buildAgentWire } from "../../steps/plan.ts";
import { type ExecuteDeps, realDeps, runAgent } from "../../steps/run.ts";
import { ensureManagedCodexHome } from "../codex-home.ts";
import { stripApiCredentials } from "../env.ts";
import { makeTmpDir, removeTmpDir } from "../test-fixtures.ts";
import {
  assertLivePreconditions,
  makeScratchRepo,
} from "./fixtures/live-env.ts";

// The staleness half of the resume contract, against the real harnesses: a
// session pointer that names nothing must surface as the resumeFailed marker,
// never as a thrown step (which the SDK would retry three times) and never as
// a silently fresh session pretending to hold the context.

let tmp: string;
let deps: ExecuteDeps;
beforeAll(() => {
  assertLivePreconditions();
  stripApiCredentials();
  tmp = makeTmpDir();
  deps = {
    ...realDeps,
    ensureCodexHome: (runKey) =>
      ensureManagedCodexHome(runKey, {
        baseDir: path.join(tmp, "codex-homes"),
      }),
  };
});
afterAll(() => {
  removeTmpDir(tmp);
});

test("a codex thread id with no rollout behind it reports resumeFailed", async () => {
  const wire = buildAgentWire({
    harness: codex({ model: "gpt-5.5" }),
    cwd: makeScratchRepo(tmp, "codex-resume"),
    prompt: "Reply with exactly OK and nothing else.",
    resume: { harness: "codex", id: `0199${crypto.randomUUID().slice(4)}` },
  });

  const result = await runAgent(wire, "live-codex-resume", deps);

  expect(result).toHaveProperty("resumeFailed");
  // The finding ADR 0004's amendment records: codex 0.149.1 raises a raw
  // JSON-RPC error that does not match the provider's /thread.*not found/i
  // wrapper, so nothing in jigs may key off an error string.
  const { resumeFailed } = result as { resumeFailed: string };
  expect(resumeFailed).not.toMatch(/thread.*not found/i);
});

test("a claude session id with no transcript behind it reports resumeFailed", async () => {
  const wire = buildAgentWire({
    harness: claude({ model: "sonnet" }),
    cwd: makeScratchRepo(tmp, "claude-resume"),
    prompt: "Reply with exactly OK and nothing else.",
    resume: { harness: "claude", id: crypto.randomUUID() },
  });

  const result = await runAgent(wire, "live-claude-resume", deps);

  expect(result).toHaveProperty("resumeFailed");
});
