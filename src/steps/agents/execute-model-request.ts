import { formatFailures, runChecks } from "../../checks/catalog.ts";
import { JigsError } from "../../errors.ts";
import type { AskJevOptions, JevQuestions, JevResult } from "../../workflow/agents/jev.ts";
import type { ModelRequest } from "../../workflow/agents/plan.ts";
import { type ModelResult, toModelResult } from "../../workflow/agents/result.ts";
import type { RunMetadata } from "../runtime/run-context.ts";
import { recordDecision } from "./decision-log.ts";
import { outputSpec } from "./execute-agent.ts";
import { harnessEnv } from "./harnesses/env.ts";
import { type ExecutionSeams, executionSeams } from "./seams.ts";

/**
 * Ask an API-backed model source.
 *
 * @group Execution primitives
 */
export function executeModel(wire: ModelRequest, metadata: RunMetadata): Promise<ModelResult> {
  return executeModelWith(wire, metadata, executionSeams);
}

export async function executeModelWith(
  wire: ModelRequest,
  metadata: RunMetadata,
  deps: ExecutionSeams,
): Promise<ModelResult> {
  const driver = deps.resolveDriver(wire.model.kind);
  if (driver?.ask === undefined)
    throw new JigsError(`no driver is registered for ${wire.model.kind}`);
  if (driver.family !== "model")
    throw new JigsError(`${wire.model.kind} is an agent harness, not a model source`);
  const requestReport = await runChecks(driver.requestChecks(wire));
  if (!requestReport.ok) throw new JigsError(formatFailures(requestReport));
  const generation = await driver.ask(wire, {
    metadata,
    deps,
    env: harnessEnv(driver.envAllowlist(wire)),
    output: outputSpec(wire.outputSchema),
  });
  return toModelResult(generation, wire.outputSchema === undefined ? undefined : generation.output);
}

/**
 * Evaluate typed questions with a decision-capable model.
 *
 * @group Execution primitives
 */
export function executeJev<const QUESTIONS extends JevQuestions>(
  wire: AskJevOptions<QUESTIONS>,
  metadata: RunMetadata,
): Promise<JevResult<QUESTIONS>> {
  return executeJevWith(wire, metadata, executionSeams);
}

export async function executeJevWith<const QUESTIONS extends JevQuestions>(
  wire: AskJevOptions<QUESTIONS>,
  metadata: RunMetadata,
  deps: ExecutionSeams,
): Promise<JevResult<QUESTIONS>> {
  const driver = deps.resolveDriver(wire.model.kind);
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
  const requestReport = await runChecks(driver.requestChecks(wire));
  if (!requestReport.ok) throw new JigsError(formatFailures(requestReport));
  const generation = await driver.decide(wire, {
    metadata,
    deps,
    env: harnessEnv(driver.envAllowlist(wire)),
  });
  await recordDecision(metadata, wire, generation.answers);
  return { answers: generation.answers };
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
