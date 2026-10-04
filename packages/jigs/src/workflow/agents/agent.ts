// The workflow half of the agent step: a plain function that plans a
// fully-serializable wire, hands it to the step function the factory injects,
// and zod-parses the recorded raw output back into the typed AgentResult.
// Memoization is the SDK's positional replay — no author-supplied keys
// anywhere.
//
// ../../steps/agents/execute-agent.ts is the step side of the same split.

import type { FailedCheck } from "../../checks/catalog.ts";
import { isResumeFailed, resumeFailed } from "./agent-session.ts";
import {
  type AgentRequest,
  buildAgentRequest,
  parseOrAskAgain,
  type RunAgentOptions,
} from "./plan.ts";
import type { AgentResult } from "./result.ts";

// Thrown in the workflow, never inside the step: a step's rejection is rebuilt
// from its message alone, so a JIT failure crosses the boundary as a returned
// value and becomes an error here, where `instanceof` still means something.
//
// The failures travel as the catalog's own records. A caller that has to write
// them for a human reads the fields; only the message is a rendering, and it
// exists because an Error has to have one.
/**
 * A failed just-in-time tool check, with repair details for each failure.
 *
 * @group Errors and utilities
 */
export class JitCheckError extends Error {
  readonly failures: FailedCheck[];

  constructor(failures: FailedCheck[]) {
    super(failures.map(({ label, reason }) => `${label}: ${reason}`).join("\n"));
    this.name = "JitCheckError";
    this.failures = failures;
  }
}

/**
 * The factory's `"use step"` wrapper around `executeAgent`.
 *
 * @group Factory plumbing
 */
export type ExecuteAgentStep = (
  wire: AgentRequest,
) => Promise<AgentResult | { jitFailure: FailedCheck[] } | { resumeFailed: string }>;

// Where the step's returned markers become errors: in the workflow, so no
// retries are spent and `instanceof` still means something to the caller.
/**
 * Convert returned execution failure markers into errors the workflow throws.
 *
 * @group Agent and model requests/results
 */
export function unwrapAgentStep(result: Awaited<ReturnType<ExecuteAgentStep>>): AgentResult {
  if ("jitFailure" in result) throw new JitCheckError(result.jitFailure);
  // Same shape, same reason as the JIT marker, but the error it becomes is
  // ./agent-session's business: only the fallback there may recognize it.
  if ("resumeFailed" in result) resumeFailed(result.resumeFailed);
  return result;
}

/**
 * Run an agent through a durable wrapper and parse its optional structured output.
 *
 * @remarks
 * An answer that fails `output` is asked for once more with the reasons: the agent's session is
 * resumed with only the reasons when the harness returned one, and otherwise, or when that session
 * cannot be resumed, the original request is sent again with the reasons appended to its prompt.
 * A second invalid answer throws its `ZodError`.
 */
export async function runAgent<T = undefined>(
  config: RunAgentOptions<T>,
  executeAgent: ExecuteAgentStep,
): Promise<AgentResult<T>> {
  const run = async (options: RunAgentOptions<T>) =>
    unwrapAgentStep(await executeAgent(buildAgentRequest(options)));
  const result = await run(config);
  return parseOrAskAgain(config.output, result, async (rejection, error) => {
    if (result.session !== undefined) {
      try {
        return await run({ ...config, resume: result.session, prompt: rejection });
      } catch (resumeError) {
        if (!isResumeFailed(resumeError)) throw resumeError;
      }
    }
    try {
      return await run({ ...config, prompt: `${config.prompt}\n\n${rejection}` });
    } catch (resumeError) {
      // A resume failure escaping here would send agentSession back to its fresh
      // prompt, and to a third retry of the same bad answer.
      if (isResumeFailed(resumeError)) throw error;
      throw resumeError;
    }
  });
}
