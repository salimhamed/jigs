import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { harnesses, models } from "../../../../workflow/agents/harness-config.ts";
import { buildAgentRequest } from "../../../../workflow/agents/plan.ts";
import { type DriverResolver, driverFor } from "../../drivers/index.ts";
import { createPiDriver } from "../../drivers/pi.ts";
import { executeAgentWith } from "../../execute-agent.ts";
import { executionSeams } from "../../seams.ts";
import type { AgentStreamPart } from "../../step-stream.ts";
import { executePi } from "../pi.ts";
import { preparePiInvocationHome, realPiAuthPath } from "../pi-home.ts";
import { makeTmpDir, removeTmpDir } from "../test-fixtures.ts";
import { makeScratchRepo } from "./fixtures/live-env.ts";

function hasOpenaiCodexLogin(): boolean {
  try {
    const auth = JSON.parse(readFileSync(realPiAuthPath(), "utf8")) as unknown;
    return typeof auth === "object" && auth !== null && "openai-codex" in auth;
  } catch {
    return false;
  }
}
let tmp: string;
beforeAll(() => {
  tmp = makeTmpDir();
  vi.stubEnv("XDG_DATA_HOME", path.join(tmp, "data"));
});
afterAll(() => {
  vi.unstubAllEnvs();
  removeTmpDir(tmp);
});

test.skipIf(!hasOpenaiCodexLogin())(
  "a live Pi agent step streams tool activity before it returns",
  async () => {
    const worktree = makeScratchRepo(tmp, "pi-stream");
    const release = path.join(worktree, "release");
    const parts: AgentStreamPart[] = [];
    const beforeReturn: AgentStreamPart[] = [];
    let returned = false;
    const writable = new WritableStream<AgentStreamPart>({
      write(part) {
        parts.push(part);
        if (!returned) beforeReturn.push(part);
      },
    });
    const pi = createPiDriver({
      openStepStream: () => ({ attempt: 1, writable }),
      preparePiHome: async (runId, source) =>
        preparePiInvocationHome(runId, source, {
          baseDir: path.join(tmp, "pi-homes"),
        }),
      executePi,
    });
    const execution = executeAgentWith(
      buildAgentRequest({
        harness: harnesses.pi(models.openaiCodex("gpt-5.5"), { tools: ["bash"], thinking: "low" }),
        cwd: worktree,
        prompt: [
          "Say 'Starting stream probe.' Then call bash exactly once with this command:",
          "touch started; while [ ! -f release ]; do sleep 0.1; done; printf STREAM-PROBE",
          "The test will create release; do not create it yourself. After bash returns, reply with its output.",
        ].join("\n"),
      }),
      { workflowRunId: `live-pi-stream-${crypto.randomUUID()}` },
      {
        ...executionSeams,
        factoryEnv: () => [],
        resolveDriver: ((kind) => (kind === "pi" ? pi : driverFor(kind))) as DriverResolver,
      },
    ).finally(() => {
      returned = true;
    });
    void execution.catch(() => {});
    try {
      await expect
        .poll(() => existsSync(path.join(worktree, "started")), {
          timeout: 120_000,
        })
        .toBe(true);
      await expect.poll(() => parts.some((part) => part.type === "tool-call")).toBe(true);
      expect(returned).toBe(false);
      expect(parts[0]).toMatchObject({ type: "attempt-start", harness: "pi" });
    } finally {
      writeFileSync(release, "go");
      await execution;
    }
    expect(await execution).toMatchObject({ text: expect.stringContaining("STREAM-PROBE") });
    expect(beforeReturn.length).toBeGreaterThanOrEqual(3);
    expect(beforeReturn.some((part) => part.type === "tool-result")).toBe(true);
    expect(parts.at(-1)).toEqual({ type: "finish", finishReason: "stop" });
    expect(writable.locked).toBe(false);
  },
);
