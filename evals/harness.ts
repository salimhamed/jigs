import { appendFileSync } from "node:fs";
import { test } from "vitest";
import { executeJev } from "../src/steps/agents/execute-model-request.ts";
import { decide } from "../src/workflow/agents/decide.ts";
import type {
  ChoiceQuestion,
  JevQuestion,
  JevState,
  YesNoQuestion,
} from "../src/workflow/agents/jev.ts";

/** A choice expects an option key, a yes-or-no a boolean, and a score its level index. */
type Expected<QUESTION extends JevQuestion> =
  QUESTION extends ChoiceQuestion<infer OPTIONS>
    ? Extract<keyof OPTIONS, string>
    : QUESTION extends YesNoQuestion
      ? boolean
      : number;

export interface EvalCase<QUESTION extends JevQuestion> {
  name: string;
  state: JevState;
  expected: Expected<QUESTION>;
}

export interface EvalSet<QUESTION extends JevQuestion> {
  question: QUESTION;
  cutoff: number;
  cases: EvalCase<QUESTION>[];
}

interface Outcome {
  name: string;
  expected: unknown;
  actual?: unknown;
  confidence?: number;
  confident?: boolean;
  error?: string;
}

/**
 * Run one decision site's cases against the live model and report how it did.
 *
 * @remarks
 * Report-only: a wrong answer never fails the run. The test fails only when every case errors,
 * which means the setup is broken rather than the model.
 */
export function evalSite<const QUESTION extends JevQuestion>(
  site: string,
  set: EvalSet<QUESTION>,
): void {
  test.skipIf(!process.env.OPENROUTER_API_KEY)(site, async () => {
    const outcomes = await Promise.all(set.cases.map((c) => runCase(site, set, c)));
    report(site, set.cutoff, outcomes);
    if (outcomes.every((outcome) => outcome.error !== undefined))
      throw new Error(`every ${site} case errored; first: ${outcomes[0]?.error}`);
  });
}

async function runCase<QUESTION extends JevQuestion>(
  site: string,
  set: EvalSet<QUESTION>,
  evalCase: EvalCase<QUESTION>,
): Promise<Outcome> {
  const base = { name: evalCase.name, expected: evalCase.expected };
  try {
    const decision = await decide(
      { site, state: evalCase.state, question: set.question, cutoff: set.cutoff },
      (wire) => executeJev(wire, { workflowRunId: `eval-${site}-${crypto.randomUUID()}` }),
    );
    const answer: { choice?: string; probability?: number; score?: number } = decision.answer;
    const actual =
      answer.choice ??
      (answer.probability !== undefined
        ? answer.probability >= 0.5
        : Math.round(answer.score ?? -1));
    return { ...base, actual, confidence: decision.confidence, confident: decision.confident };
  } catch (error) {
    return { ...base, error: error instanceof Error ? error.message : String(error) };
  }
}

function mean(values: number[]): string {
  return values.length === 0
    ? "n/a"
    : (values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2);
}

function report(site: string, cutoff: number, outcomes: Outcome[]): void {
  const answered = outcomes.filter((outcome) => outcome.error === undefined);
  const right = answered.filter((outcome) => outcome.actual === outcome.expected);
  const wrong = answered.filter((outcome) => outcome.actual !== outcome.expected);
  const confident = answered.filter((outcome) => outcome.confident);
  const confidentRight = confident.filter((outcome) => outcome.actual === outcome.expected);
  const confidence = (list: Outcome[]) => mean(list.map((outcome) => outcome.confidence ?? 0));

  const summary = [
    `### ${site}`,
    "",
    `- Accuracy: ${right.length}/${answered.length}`,
    `- Confident (cutoff ${cutoff}): ${confident.length}/${answered.length}, of which right: ${confidentRight.length}`,
    `- Confident but wrong: ${confident.length - confidentRight.length}`,
    `- Mean confidence: right ${confidence(right)}, wrong ${confidence(wrong)}`,
    ...(outcomes.length > answered.length
      ? [`- Errors: ${outcomes.length - answered.length}`]
      : []),
    "",
    ...outcomes.map((outcome) =>
      outcome.error !== undefined
        ? `- ERROR ${outcome.name}: ${outcome.error}`
        : `- ${outcome.actual === outcome.expected ? "ok  " : "MISS"} ${outcome.name}: expected ${String(outcome.expected)}, got ${String(outcome.actual)} (${outcome.confidence?.toFixed(2)}${outcome.confident ? "" : ", below cutoff"})`,
    ),
    "",
  ].join("\n");

  console.log(summary);
  const stepSummary = process.env.GITHUB_STEP_SUMMARY;
  if (stepSummary) appendFileSync(stepSummary, `${summary}\n`);
}
