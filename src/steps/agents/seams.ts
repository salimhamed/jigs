import {
  experimental_evaluate,
  generateText,
  type LanguageModel,
  type OutputInterface,
  streamText,
  type TextStreamPart,
  type ToolSet,
} from "ai";
import {
  type FailedCheck,
  failedChecks,
  JIT_TIMEOUT_MS,
  jitChecks,
  runChecks,
} from "../../checks/index.ts";
import {
  type DriverDependencies,
  type DriverResolver,
  driverFor,
  type ExecutorGeneration,
  type HarnessTarget,
} from "./drivers/index.ts";
import { factoryAgentEnv } from "./harnesses/env.ts";
import { openStepStream, type StepStream } from "./step-stream.ts";

/** The parts of a `streamText` result an agent run reads. */
export interface AgentTextStream {
  fullStream: AsyncIterable<TextStreamPart<ToolSet>>;
  text: PromiseLike<string>;
  output: PromiseLike<unknown>;
  providerMetadata: PromiseLike<ExecutorGeneration["providerMetadata"]>;
}

// What the agent and model steps reach outside themselves. Tests replace it
// through the internal entry points; the public steps take none.
export interface ExecutionSeams extends DriverDependencies {
  streamText(options: {
    model: LanguageModel;
    prompt: string;
    output?: OutputInterface<unknown, unknown, never>;
  }): AgentTextStream;
  openStepStream(): StepStream | undefined;
  resolveDriver: DriverResolver;
  /** Names the factory declares under `agents.env` in `jigs.config.ts`. */
  factoryEnv(): readonly string[];
  jitFailures(
    target: HarnessTarget,
    env: Record<string, string>,
  ): Promise<FailedCheck[] | undefined>;
}

export const executionSeams: ExecutionSeams = {
  generateText: (options) => generateText(options),
  // The run rethrows the stream's error itself; the SDK's default would also log it.
  streamText: (options) => streamText({ ...options, onError: () => {} }),
  openStepStream,
  evaluate: (options) => experimental_evaluate(options),
  resolveDriver: driverFor,
  factoryEnv: factoryAgentEnv,
  jitFailures: async (target, env) => {
    const report = await runChecks(jitChecks(target, env), JIT_TIMEOUT_MS);
    return report.ok ? undefined : failedChecks(report);
  },
};
