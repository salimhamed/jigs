import type { AskJevOptions, JevQuestions, JevResult } from "../../blocks/agents/jev.ts";
import type { ModelRequest } from "../../blocks/agents/plan.ts";
import { type ModelResult, toModelResult } from "../../blocks/agents/result.ts";
import { formatFailures, runChecks } from "../../checks/catalog.ts";
import { JigsError } from "../../errors.ts";
import type { RunMetadata } from "../runtime/run-context.ts";
import { driverFor } from "./drivers/index.ts";
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
  const driver = driverFor(wire.model.kind);
  if (driver?.ask === undefined)
    throw new JigsError(`no driver is registered for ${wire.model.kind}`);
  const runtimeReport = await runChecks(driver.runtimeChecks(wire));
  if (!runtimeReport.ok) throw new JigsError(formatFailures(runtimeReport));
  const generation = await driver.ask(wire, {
    metadata,
    deps,
    env: scrubbedEnv(driver.envAllowlist(wire)),
    output: outputSpec(wire.outputSchema),
  });
  const costUsd = driver.cost(generation);
  return toModelResult(
    costUsd === undefined ? generation : { ...generation, costUsd },
    wire.outputSchema === undefined ? undefined : generation.output,
  );
}

/** Evaluate typed questions with a decision-capable model. */
export async function executeJev<const QUESTIONS extends JevQuestions>(
  wire: AskJevOptions<QUESTIONS>,
  metadata: RunMetadata,
  deps: AgentExecutionDependencies = defaultAgentExecutionDependencies,
): Promise<JevResult<QUESTIONS>> {
  const driver = driverFor(wire.model.kind);
  if (driver?.decide === undefined)
    throw new JigsError(
      `${wire.model.model} cannot be used with askJev: no decision driver exists`,
    );
  if (!isJsonValue(wire.state, new Set()))
    throw new JigsError("askJev state must be JSON-compatible and contain no cycles");
  for (const [key, question] of Object.entries(wire.questions)) {
    if (typeof question.instructions !== "string" || question.instructions.trim() === "")
      throw new JigsError(`question "${key}" is malformed: instructions must not be empty`);
    if (
      question.type === "choice" &&
      (Object.keys(question.options).length === 0 ||
        Object.values(question.options).some((description) => description.trim() === ""))
    )
      throw new JigsError(
        `question "${key}" is malformed: choices need at least one described option`,
      );
    if (
      question.type === "score" &&
      (!Array.isArray(question.levels) ||
        question.levels.length < 2 ||
        question.levels.some((level) => typeof level !== "string" || level.trim() === ""))
    )
      throw new JigsError(
        `question "${key}" is malformed: scores need at least two described levels`,
      );
  }
  const runtimeReport = await runChecks([
    ...driver.runtimeChecks(wire),
    ...driver.authChecks(wire),
  ]);
  if (!runtimeReport.ok) throw new JigsError(formatFailures(runtimeReport));
  const generation = await driver.decide(wire, {
    metadata,
    deps,
    env: scrubbedEnv(driver.envAllowlist(wire)),
  });
  const costUsd = driver.cost(generation);
  return {
    answers: generation.answers,
    usage: costUsd === undefined ? generation.usage : { ...generation.usage, costUsd },
  };
}

function isJsonValue(value: unknown, ancestors: Set<object>): boolean {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  )
    return true;
  if (typeof value !== "object") return false;
  if (ancestors.has(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) return false;
  ancestors.add(value);
  const children = Array.isArray(value) ? value : Object.values(value);
  const valid = children.every((child) => isJsonValue(child, ancestors));
  ancestors.delete(value);
  return valid;
}
