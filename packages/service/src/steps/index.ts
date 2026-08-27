// The three step builders (ADR 0003) on the Workflow SDK (ADR 0008): plain
// workflow-side functions that plan a fully-serializable wire, cross the
// boundary through a fixed "use step" shim, and zod-parse the recorded raw
// output back into the typed StepResult. Memoization is the SDK's positional
// replay — no author-supplied keys anywhere.

import {
  type AgentStepConfig,
  type AgentStepResult,
  type AgentWire,
  type AskStepConfig,
  type AskWire,
  buildAgentWire,
  buildAskWire,
  type StepResult,
} from "jigs/steps";
import { getWorkflowMetadata } from "workflow";

export async function agent<T = undefined>(
  config: AgentStepConfig<T>,
): Promise<AgentStepResult<T>> {
  const { wire, parseOutput } = buildAgentWire(config);
  const result = await runAgentStep(wire);
  return { ...result, output: parseOutput(result.output) };
}

export async function ask<T = undefined>(
  config: AskStepConfig<T>,
): Promise<StepResult<T>> {
  const { wire, parseOutput } = buildAskWire(config);
  const result = await runAskStep(wire);
  return { ...result, output: parseOutput(result.output) };
}

// The author's function carries its own "use step" at module scope; fn() only
// normalizes its recorded return — deterministic workflow-side code, so
// replay yields the identical StepResult. A closure can never cross the
// boundary, which makes reference-plus-serializable-args the only honest
// shape under the directive model.
export async function fn<Args extends unknown[], R>(
  step: (...args: Args) => R | Promise<R>,
  ...args: Args
): Promise<StepResult<R>> {
  const output = await step(...args);
  return { text: "", output, files: [], usage: undefined };
}

// The executors touch node builtins, which the workflow bundle must never
// see even transitively — hence the dynamic import inside the step body,
// which the directive transform strips from the workflow side.
async function runAgentStep(wire: AgentWire): Promise<AgentStepResult> {
  "use step";
  const { executeAgentStep } = await import("jigs/steps/execute");
  const { workflowRunId } = getWorkflowMetadata();
  return executeAgentStep(wire, workflowRunId);
}

async function runAskStep(wire: AskWire): Promise<StepResult> {
  "use step";
  const { executeAskStep } = await import("jigs/steps/execute");
  const { workflowRunId } = getWorkflowMetadata();
  return executeAskStep(wire, workflowRunId);
}
