import { existsSync, readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { z } from "zod";
import { askAgent } from "../../../../workflow/agents/ask-agent.ts";
import { harnesses, models } from "../../../../workflow/agents/harness-config.ts";
import { type DriverResolver, driverFor } from "../../drivers/index.ts";
import { createPiDriver } from "../../drivers/pi.ts";
import { executeAgentWith } from "../../execute-agent.ts";
import { type ExecutionSeams, executionSeams } from "../../seams.ts";
import { executePi, type PiExecutionOptions } from "../pi.ts";
import { SUBMIT_RESULT_TOOL } from "../pi-extension.ts";
import { preparePiInvocationHome, realPiAuthPath } from "../pi-home.ts";

const baseUrl = process.env.JIGS_TEST_OPENAI_COMPATIBLE_BASE_URL;
const localModel = process.env.JIGS_TEST_OPENAI_COMPATIBLE_MODEL;
const localConfigured =
  baseUrl !== undefined && baseUrl !== "" && localModel !== undefined && localModel !== "";
const localReachable = localConfigured
  ? await fetch(`${baseUrl.replace(/\/$/, "")}/models`, { signal: AbortSignal.timeout(3_000) })
      .then((response) => response.ok)
      .catch(() => false)
  : false;

function hasOpenaiCodexLogin(): boolean {
  const authPath = realPiAuthPath();
  if (!existsSync(authPath)) return false;
  try {
    const auth = JSON.parse(readFileSync(authPath, "utf8")) as unknown;
    return typeof auth === "object" && auth !== null && "openai-codex" in auth;
  } catch {
    return false;
  }
}

const answer = z.object({ word: z.string(), count: z.number() });

// Records each Pi launch so a test can prove which tools the ask exposed. The
// result can only come from submit_result: requireResult rejects a turn whose
// answer is JSON-looking text.
function recordingDeps(): { deps: ExecutionSeams; launches: PiExecutionOptions[] } {
  const launches: PiExecutionOptions[] = [];
  const pi = createPiDriver({
    preparePiHome: async (runId, plan) => preparePiInvocationHome(runId, plan),
    executePi: (options) => {
      launches.push(options);
      return executePi(options);
    },
  });
  return {
    launches,
    deps: {
      ...executionSeams,
      factoryEnv: () => [],
      resolveDriver: ((kind) => (kind === "pi" ? pi : driverFor(kind))) as DriverResolver,
    },
  };
}

function expectToolsOffThenSubmitResult(launches: PiExecutionOptions[]): void {
  const [plain, structured] = launches;
  expect(launches).toHaveLength(2);
  expect(plain?.args).toContain("--no-tools");
  expect(plain?.args).not.toContain("-e");
  expect(plain?.requireResult).toBe(false);
  const tools = structured?.args.indexOf("--tools") ?? -1;
  expect(structured?.args[tools + 1]).toBe(SUBMIT_RESULT_TOOL);
  expect(structured?.requireResult).toBe(true);
}

test.skipIf(!localConfigured || !localReachable)(
  "Pi asks an LM Studio OpenAI-compatible model for text and structured output",
  async () => {
    const { deps, launches } = recordingDeps();
    const model = models.openaiCompatible({
      name: "lmstudio",
      baseUrl: baseUrl as string,
      model: localModel as string,
    });
    const plain = await askAgent(
      { harness: harnesses.pi(model), prompt: "Reply with exactly PONG." },
      (wire) =>
        executeAgentWith(
          wire,
          { workflowRunId: `live-pi-local-plain-${crypto.randomUUID()}` },
          deps,
        ),
    );
    const structured = await askAgent(
      {
        harness: harnesses.pi(model),
        prompt: "Return the word sky and the number 3.",
        output: answer,
      },
      (wire) =>
        executeAgentWith(
          wire,
          { workflowRunId: `live-pi-local-json-${crypto.randomUUID()}` },
          deps,
        ),
    );
    expect(plain.text.toUpperCase()).toContain("PONG");
    expect(structured.output).toEqual({ word: "sky", count: 3 });
    expectToolsOffThenSubmitResult(launches);
  },
);

test.skipIf(!hasOpenaiCodexLogin())(
  "Pi asks OpenAI Codex gpt-5.5 for text and structured output",
  async () => {
    const { deps, launches } = recordingDeps();
    const model = models.openaiCodex("gpt-5.5");
    const plain = await askAgent(
      { harness: harnesses.pi(model, { thinking: "low" }), prompt: "Reply with exactly PONG." },
      (wire) =>
        executeAgentWith(
          wire,
          { workflowRunId: `live-pi-codex-plain-${crypto.randomUUID()}` },
          deps,
        ),
    );
    const structured = await askAgent(
      {
        harness: harnesses.pi(model, { thinking: "low" }),
        prompt: "Return the word sky and the number 3.",
        output: answer,
      },
      (wire) =>
        executeAgentWith(
          wire,
          { workflowRunId: `live-pi-codex-json-${crypto.randomUUID()}` },
          deps,
        ),
    );
    expect(plain.text.toUpperCase()).toContain("PONG");
    expect(structured.output).toEqual({ word: "sky", count: 3 });
    expectToolsOffThenSubmitResult(launches);
  },
);
