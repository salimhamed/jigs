// Runs one resumed Pi turn in a fresh Node process, so a continuation cannot
// lean on anything the first turn's process still holds in memory.

import { writeFileSync } from "node:fs";
import { harnesses, models } from "../../../../../workflow/agents/harness-config.ts";
import { buildAgentRequest } from "../../../../../workflow/agents/plan.ts";
import type { AgentSession } from "../../../../../workflow/agents/result.ts";
import { type DriverResolver, driverFor } from "../../../drivers/index.ts";
import { createPiDriver } from "../../../drivers/pi.ts";
import { defaultAgentExecutionDependencies, executeAgent } from "../../../execute-agent.ts";
import { executePi } from "../../pi.ts";
import { preparePiInvocationHome } from "../../pi-home.ts";

type Input = {
  baseDir: string;
  baseUrl: string;
  model: string;
  runId: string;
  cwd: string;
  prompt: string;
  resume: AgentSession;
  resultFile: string;
};

const input = JSON.parse(process.argv[2] ?? "") as Input;
const pi = createPiDriver({
  preparePiHome: (runId, plan) => preparePiInvocationHome(runId, plan, { baseDir: input.baseDir }),
  executePi,
});
const result = await executeAgent(
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
    ...defaultAgentExecutionDependencies,
    factoryEnv: () => [],
    resolveDriver: ((kind) => (kind === "pi" ? pi : driverFor(kind))) as DriverResolver,
  },
);
writeFileSync(input.resultFile, JSON.stringify(result));
