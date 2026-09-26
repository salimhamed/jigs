/**
 * Live evals for Jev decisions: hand-written cases asked of the real model, with
 * a report of how often it was right and how often it was sure.
 *
 * @packageDocumentation
 */

// Free of any test runner, so a factory calls it from whichever it uses.
import { appendFileSync } from "node:fs";
import { executeJev } from "../steps/agents/execute-model-request.ts";
import { removeRunDirectory } from "../steps/runtime/run-directory/index.ts";
import {
  type DecisionRule,
  type DecisionValue,
  jevModel,
  resolveAnswer,
} from "../workflow/agents/decide.ts";
import type { ExecuteJevStep, JevAnswer, JevQuestion, JevState } from "../workflow/agents/jev.ts";

/** One case: the state Jev sees and the answer a person would give. */
export type EvalCase<QUESTION extends JevQuestion> = {
  name: string;
  state: JevState;
  expected: DecisionValue<QUESTION>;
};

/** A decision site's rule, exactly as the workflow asks it, and its cases. */
export type EvalSet<QUESTION extends JevQuestion> = {
  site: string;
  rule: DecisionRule<QUESTION>;
  cases: EvalCase<QUESTION>[];
};

/** How one case went: Jev's own answer, and whether the rule acted on it. */
export type EvalOutcome = {
  name: string;
  expected: string | boolean | number;
  answer?: string | boolean | number;
  confidence?: number;
  unsure?: boolean;
  error?: string;
};

/** Whether the default Jev model's key is set, so live evals can run. */
export function evalsConfigured(): boolean {
  return Boolean(process.env[jevModel.apiKeyEnv]);
}

/**
 * Ask every case of one set, print a report, and return the outcomes.
 *
 * @remarks
 * Report-only: a wrong answer never throws. It throws only when every case
 * errored, which means the setup is broken rather than the model. The report
 * is also appended to `$GITHUB_STEP_SUMMARY` when that is set.
 */
export async function runEvalSet<const QUESTION extends JevQuestion>(
  set: EvalSet<QUESTION>,
  options: { executeJev?: ExecuteJevStep; write?: (text: string) => void } = {},
): Promise<EvalOutcome[]> {
  const execute: ExecuteJevStep =
    options.executeJev ??
    (async (wire) => {
      const metadata = { workflowRunId: `eval-${crypto.randomUUID()}` };
      try {
        return await executeJev(wire, metadata);
      } finally {
        await removeRunDirectory(metadata);
      }
    });
  const outcomes = await Promise.all(set.cases.map((evalCase) => runCase(set, evalCase, execute)));
  const text = report(set, outcomes);
  (options.write ?? ((line) => process.stdout.write(line)))(text);
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) appendFileSync(summary, text);
  if (outcomes.every((outcome) => outcome.error !== undefined))
    throw new Error(`every ${set.site} case errored; first: ${outcomes[0]?.error}`);
  return outcomes;
}

async function runCase<QUESTION extends JevQuestion>(
  set: EvalSet<QUESTION>,
  evalCase: EvalCase<QUESTION>,
  execute: ExecuteJevStep,
): Promise<EvalOutcome> {
  const base = { name: evalCase.name, expected: evalCase.expected };
  try {
    const result = await execute({
      model: jevModel,
      site: set.site,
      state: evalCase.state,
      questions: { decision: set.rule.question as JevQuestion },
    });
    const answer: JevAnswer<JevQuestion> = result.answers.decision;
    const own = resolveAnswer({ whenUnsure: set.rule.whenUnsure, cutoff: 0 }, answer);
    const acted = resolveAnswer(set.rule, answer);
    return { ...base, answer: own.value, confidence: own.confidence, unsure: acted.unsure };
  } catch (error) {
    return { ...base, error: error instanceof Error ? error.message : String(error) };
  }
}

function mean(values: number[]): string {
  return values.length === 0
    ? "n/a"
    : (values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2);
}

function report<QUESTION extends JevQuestion>(set: EvalSet<QUESTION>, outcomes: EvalOutcome[]) {
  const answered = outcomes.filter((outcome) => outcome.error === undefined);
  const right = answered.filter((outcome) => outcome.answer === outcome.expected);
  const wrong = answered.filter((outcome) => outcome.answer !== outcome.expected);
  const sure = answered.filter((outcome) => !outcome.unsure);
  const sureWrong = sure.filter((outcome) => outcome.answer !== outcome.expected);
  const confidence = (list: EvalOutcome[]) => mean(list.map((outcome) => outcome.confidence ?? 0));
  const cutoff = set.rule.cutoff ?? 0.9;
  const errors = outcomes.length - answered.length;

  return [
    `### ${set.site}`,
    "",
    `- Accuracy: ${right.length}/${answered.length}`,
    `- Acted on (cutoff ${cutoff}): ${sure.length}/${answered.length}; the rest used whenUnsure (${String(set.rule.whenUnsure)})`,
    `- Sure but wrong: ${sureWrong.length}`,
    `- Mean confidence: right ${confidence(right)}, wrong ${confidence(wrong)}`,
    ...(errors > 0 ? [`- Errors: ${errors}`] : []),
    "",
    ...outcomes.map((outcome) =>
      outcome.error !== undefined
        ? `- ERROR ${outcome.name}: ${outcome.error}`
        : `- ${outcome.answer === outcome.expected ? "ok  " : "MISS"} ${outcome.name}: expected ${String(outcome.expected)}, got ${String(outcome.answer)} (${outcome.confidence?.toFixed(2)}${outcome.unsure ? ", unsure" : ""})`,
    ),
    "",
    "",
  ].join("\n");
}
