import type { ModelRequest } from "../../blocks/agents/plan.ts";
import { type ModelResult, toModelResult } from "../../blocks/agents/result.ts";
import { JigsError } from "../../errors.ts";
import type { RunMetadata } from "../runtime/run-context.ts";
import { type Driver, drivers } from "./drivers/index.ts";
import {
  type AgentExecutionDependencies,
  defaultAgentExecutionDependencies,
  outputSpec,
} from "./execute-agent.ts";
import { scrubbedEnv } from "./harnesses/env.ts";

/** Ask an API-backed model source. */
export async function executeModel(
  wire: ModelRequest,
  metadata: RunMetadata,
  deps: AgentExecutionDependencies = defaultAgentExecutionDependencies,
): Promise<ModelResult> {
  const driver = (drivers as Record<string, Driver<keyof typeof drivers> | undefined>)[
    wire.model.kind
  ];
  if (driver?.ask === undefined)
    throw new JigsError(`no driver is registered for ${wire.model.kind}`);
  const generation = await driver.ask(wire, {
    metadata,
    deps,
    env: scrubbedEnv(driver.envAllowlist),
    output: outputSpec(wire.outputSchema),
  });
  const costUsd = driver.cost(generation);
  return toModelResult(
    costUsd === undefined ? generation : { ...generation, costUsd },
    wire.outputSchema === undefined ? undefined : generation.output,
  );
}

/** Reserved durable wrapper target for judge/evaluate/verify requests. */
export async function executeJev(_wire: unknown): Promise<never> {
  throw new JigsError("askJev is not implemented");
}
