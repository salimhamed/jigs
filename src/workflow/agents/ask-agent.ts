import type { ExecuteAgentStep } from "./agent.ts";
import { type AskAgentOptions, buildAskAgentRequest, parseOutput } from "./plan.ts";
import type { AgentResult } from "./result.ts";

/** Ask an agent harness without a worktree or tools. */
export async function askAgent<T = undefined>(
  config: AskAgentOptions<T>,
  executeAgent: ExecuteAgentStep,
): Promise<AgentResult<T>> {
  const result = await executeAgent(buildAskAgentRequest(config));
  if ("jitFailure" in result || "resumeFailed" in result) {
    throw new Error("an ask-only agent returned a run-only marker");
  }
  return { ...result, output: parseOutput(config.output, result.output) };
}
