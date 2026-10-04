// Runs one resumed Pi turn in a fresh Node process, so a continuation cannot
// lean on anything the first turn's process still holds in memory.

import { writeFileSync } from "node:fs";
import { harnesses, models } from "../../../../workflow/agents/harness-config.ts";
import { buildAgentRequest } from "../../../../workflow/agents/plan.ts";
import type { AgentSessionRef } from "../../../../workflow/agents/result.ts";
import { type DriverResolver, driverFor } from "../../shared/drivers.ts";
import { executeAgentWith } from "../../shared/execute-agent.ts";
import { executionSeams } from "../../shared/seams.ts";
import { runningRunStatus } from "../../shared/test-fixtures.ts";
import { createPiDriver } from "../driver.ts";
import { preparePiInvocationHome } from "../home.ts";
import { executePi } from "../process.ts";

type Input = {
  baseDir: string;
  baseUrl: string;
  model: string;
  runId: string;
  cwd: string;
  prompt: string;
  resume: AgentSessionRef;
  resultFile: string;
};

const input = JSON.parse(process.argv[2] ?? "") as Input;
const pi = createPiDriver({
  openStepStream: () => undefined,
  preparePiHome: async (runId, plan) =>
    preparePiInvocationHome(runId, plan, { baseDir: input.baseDir }),
  executePi,
});
const result = await executeAgentWith(
  buildAgentRequest({
    harness: harnesses.pi(
      models.openaiCompatible({ name: "lmstudio", baseUrl: input.baseUrl, model: input.model }),
    ),
    cwd: input.cwd,
    prompt: input.prompt,
    resume: input.resume,
  }),
  { workflowRunId: input.runId },
  {
    ...executionSeams,
    runStatus: runningRunStatus,
    factoryEnv: () => [],
    resolveDriver: ((kind) => (kind === "pi" ? pi : driverFor(kind))) as DriverResolver,
  },
);
writeFileSync(input.resultFile, JSON.stringify(result));
