import type { ExecuteAgentStep } from "./agent.ts";
import { type AskAgentOptions, buildAskAgentRequest, parseOrAskAgain } from "./plan.ts";
import type { AgentResult } from "./result.ts";

/**
 * Ask an agent harness without a worktree or tools. An invalid structured answer is asked for once
 * more, with the reasons.
 */
export async function askAgent<T = undefined>(
  config: AskAgentOptions<T>,
  executeAgent: ExecuteAgentStep,
): Promise<AgentResult<T>> {
  const ask = async (prompt: string): Promise<AgentResult> => {
    const result = await executeAgent(buildAskAgentRequest({ ...config, prompt }));
    if ("jitFailure" in result || "resumeFailed" in result) {
      throw new Error("an ask-only agent returned a run-only marker");
    }
    return result;
  };
  return parseOrAskAgain(config.output, await ask(config.prompt), (rejection) =>
    ask(`${config.prompt}\n\n${rejection}`),
  );
}
