import { jsonSchema, Output, type OutputInterface } from "ai";
import { formatFailures, runChecks } from "../../checks/index.ts";
import { JigsError } from "../../errors.ts";
import { type ExecuteAgentStep, JitCheckError } from "../../workflow/agents/agent.ts";
import { type AgentRequest, assertAskableHarness } from "../../workflow/agents/plan.ts";
import {
  type AgentResult,
  extractAgentSession,
  toModelResult,
} from "../../workflow/agents/result.ts";
import type { RunMetadata } from "../runtime/run-context.ts";
import type { ExecutorGeneration, RunRequest } from "./drivers/index.ts";
import { harnessEnv } from "./harnesses/env.ts";
import { openAgentRunner, prepareAgentRun } from "./runner.ts";
import { type ExecutionSeams, executionSeams } from "./seams.ts";
import { AgentSessionError } from "./session-error.ts";

export function outputSpec(
  schema: Record<string, unknown> | undefined,
): OutputInterface<unknown, unknown, never> | undefined {
  return schema === undefined ? undefined : Output.object({ schema: jsonSchema<unknown>(schema) });
}

/** Run or ask an agent harness, checking worktree requirements before a run. */
export function executeAgent(
  wire: AgentRequest,
  metadata: RunMetadata,
): ReturnType<ExecuteAgentStep> {
  return executeAgentWith(wire, metadata, executionSeams);
}

export async function executeAgentWith(
  wire: AgentRequest,
  metadata: RunMetadata,
  seams: ExecutionSeams,
): ReturnType<ExecuteAgentStep> {
  if (wire.cwd === undefined) return askAgent(wire, metadata, seams);
  try {
    return await runAgent(wire, metadata, seams);
  } catch (err) {
    if (err instanceof JitCheckError) return { jitFailure: err.failures };
    if (wire.resume !== undefined && err instanceof AgentSessionError)
      return { resumeFailed: String(err) };
    throw err;
  }
}

function resultOf(
  wire: AgentRequest,
  generation: ExecutorGeneration,
  session: AgentResult["session"],
): AgentResult {
  return {
    ...toModelResult(generation, wire.outputSchema === undefined ? undefined : generation.output),
    ...(session === undefined ? {} : { session }),
  };
}

async function runAgent(
  wire: RunRequest,
  metadata: RunMetadata,
  seams: ExecutionSeams,
): Promise<AgentResult> {
  // Pi has no provider model: its driver runs the whole call itself and builds
  // its own result tool from the schema.
  if (wire.harness.kind === "pi") {
    const prepared = await prepareAgentRun(wire, seams);
    try {
      const run = prepared.driver.run;
      if (run === undefined) throw new JigsError(`the ${wire.harness.kind} driver cannot run`);
      const generation = await run(wire, { metadata, deps: seams, env: prepared.env });
      const session = extractAgentSession(
        wire.harness,
        generation.providerMetadata,
        prepared.driver.sessionPointer,
      );
      return resultOf(wire, generation, session);
    } finally {
      prepared.release();
    }
  }
  const runner = await openAgentRunner(
    wire.harness,
    { cwd: wire.cwd, run: metadata, resume: wire.resume },
    seams,
  );
  const output = outputSpec(wire.outputSchema);
  try {
    const generation = await seams.generateText({
      model: runner.model,
      prompt: wire.prompt,
      ...(output === undefined ? {} : { output }),
    });
    return resultOf(wire, generation, runner.sessionFrom(generation));
  } finally {
    await runner.close();
  }
}

async function askAgent(
  wire: AgentRequest,
  metadata: RunMetadata,
  seams: ExecutionSeams,
): Promise<AgentResult> {
  const driver = seams.resolveDriver(wire.harness.kind);
  if (driver === undefined) throw new JigsError(`no driver is registered for ${wire.harness.kind}`);
  if (driver.family !== "harness")
    throw new JigsError(`${wire.harness.kind} is a model source, not an agent harness`);
  const env = harnessEnv([...driver.envAllowlist(wire), ...seams.factoryEnv()]);
  assertAskableHarness(wire.harness);
  if (driver.ask === undefined) throw new JigsError(`the ${wire.harness.kind} driver cannot ask`);
  const requestReport = await runChecks(driver.requestChecks(wire));
  if (!requestReport.ok) throw new JigsError(formatFailures(requestReport));
  const generation = await driver.ask(wire, {
    metadata,
    deps: seams,
    env,
    // Pi reads the schema from the request for its result tool.
    output: wire.harness.kind === "pi" ? undefined : outputSpec(wire.outputSchema),
  });
  return toModelResult(generation, wire.outputSchema === undefined ? undefined : generation.output);
}

export type { ExecutorGeneration } from "./drivers/index.ts";
