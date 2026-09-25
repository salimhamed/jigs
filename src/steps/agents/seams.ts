import { experimental_evaluate, generateText } from "ai";
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
  type HarnessTarget,
} from "./drivers/index.ts";
import { factoryAgentEnv } from "./harnesses/env.ts";

// What the agent and model steps reach outside themselves. Tests replace it
// through the internal entry points; the public steps take none.
export interface ExecutionSeams extends DriverDependencies {
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
  evaluate: (options) => experimental_evaluate(options),
  resolveDriver: driverFor,
  factoryEnv: factoryAgentEnv,
  jitFailures: async (target, env) => {
    const report = await runChecks(jitChecks(target, env), JIT_TIMEOUT_MS);
    return report.ok ? undefined : failedChecks(report);
  },
};
