import type { OpenrouterSource } from "./harness-config.ts";

/** A calibrated yes-or-no question. */
export type YesNoQuestion = { type: "yes-no"; instructions: string };

/** A question answered with one named option. */
export type ChoiceQuestion<OPTIONS extends Record<string, string> = Record<string, string>> = {
  type: "choice";
  instructions: string;
  options: OPTIONS;
};

/** A question scored over ordered levels, from lowest to highest. */
export type ScoreQuestion = { type: "score"; instructions: string; levels: string[] };

/** Any question accepted by {@link askJev}. */
export type JevQuestion = YesNoQuestion | ChoiceQuestion | ScoreQuestion;

/** Named decision questions evaluated against one shared state. */
export type JevQuestions = Record<string, JevQuestion>;

type JevJsonValue = null | boolean | number | string | JevJsonValue[] | JevJsonObject;
type JevJsonObject = { [key: string]: JevJsonValue };

/** JSON-compatible evidence evaluated by a decision model. */
export type JevState = string | JevJsonObject | JevJsonValue[];

/** The calibrated answer shape selected by one question descriptor. */
export type JevAnswer<QUESTION extends JevQuestion> =
  QUESTION extends ChoiceQuestion<infer OPTIONS>
    ? {
        choice: Extract<keyof OPTIONS, string>;
        probabilities: { [OPTION in keyof OPTIONS]: number };
        confidence: number;
      }
    : QUESTION extends ScoreQuestion
      ? {
          /** The probability-weighted expected value over the ordered levels. */
          score: number;
          probabilities: Record<string, number>;
          legend: Record<string, string>;
          confidence: number;
        }
      : { probability: number };

/** Answers narrowed independently for every named question. */
export type JevAnswers<QUESTIONS extends JevQuestions> = {
  [KEY in keyof QUESTIONS]: JevAnswer<QUESTIONS[KEY]>;
};

/** A decision request in workflow and durable wire form. */
export type AskJevOptions<QUESTIONS extends JevQuestions> = {
  model: OpenrouterSource;
  state: JevState;
  questions: QUESTIONS;
};

/** A typed decision result. */
export type JevResult<QUESTIONS extends JevQuestions> = {
  answers: JevAnswers<QUESTIONS>;
};

/** The factory's durable wrapper around the decision step. */
export type ExecuteJevStep = <const QUESTIONS extends JevQuestions>(
  request: AskJevOptions<QUESTIONS>,
) => Promise<JevResult<QUESTIONS>>;

/** Build a calibrated yes-or-no question. */
export function yesNo(instructions: string): YesNoQuestion {
  return { type: "yes-no", instructions };
}

/** Build a question answered with one named option. */
export function choice<const OPTIONS extends Record<string, string>>(
  instructions: string,
  options: OPTIONS,
): ChoiceQuestion<OPTIONS> {
  return { type: "choice", instructions, options };
}

/** Build a question scored over ordered levels, from lowest to highest. */
export function score(instructions: string, levels: string[]): ScoreQuestion {
  return { type: "score", instructions, levels };
}

/** Evaluate named typed questions against one shared state. */
export function askJev<const QUESTIONS extends JevQuestions>(
  options: AskJevOptions<QUESTIONS>,
  executeJev: ExecuteJevStep,
): Promise<JevResult<QUESTIONS>> {
  return executeJev(options);
}
