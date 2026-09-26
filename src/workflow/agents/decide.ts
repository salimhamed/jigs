import { JigsError } from "../../errors.ts";
import { models, type OpenrouterSource } from "./harness-config.ts";
import {
  askJev,
  type ChoiceQuestion,
  type ExecuteJevStep,
  type JevAnswer,
  type JevQuestion,
  type JevState,
  type YesNoQuestion,
} from "./jev.ts";

/**
 * The Jev decision model `decide` uses unless a call names another.
 *
 * @group Decision models
 */
export const jevModel: OpenrouterSource = models.openrouter("typesafe/jev-1.13");

/**
 * The confidence a decision needs unless its rule names another.
 *
 * @group Decision models
 */
export const DECISION_CUTOFF = 0.9;

/**
 * What a question decides: an option key for a choice, `true` for yes, or a
 * score's level index.
 *
 * @group Decision models
 */
export type DecisionValue<QUESTION extends JevQuestion> =
  QUESTION extends ChoiceQuestion<infer OPTIONS>
    ? Extract<keyof OPTIONS, string>
    : QUESTION extends YesNoQuestion
      ? boolean
      : number;

/**
 * One question, and the answer to act on when Jev is less sure than the cutoff.
 *
 * @group Decision models
 */
export type DecisionRule<QUESTION extends JevQuestion = JevQuestion> = {
  question: QUESTION;
  /** The safest answer to act on when unsure; the caller never sees an unsure answer. */
  whenUnsure: DecisionValue<QUESTION>;
  /** Defaults to `DECISION_CUTOFF`, 0.9. */
  cutoff?: number;
};

/**
 * Named decision rules asked together about one state.
 *
 * @group Decision models
 */
export type DecisionRules = Record<string, DecisionRule>;

/**
 * A `decide` call: the decision point's name, the evidence, and the rules.
 *
 * @group Decision models
 */
export type DecideOptions<RULES extends DecisionRules> = {
  /** A stable name for this decision point, recorded with every answer. */
  site: string;
  state: JevState;
  questions: RULES & { [KEY in keyof RULES]: DecisionRule<RULES[KEY]["question"]> };
  model?: OpenrouterSource;
};

/**
 * One value per rule: Jev's answer, or the rule's `whenUnsure` below its cutoff.
 *
 * @group Decision models
 */
export type Decided<RULES extends DecisionRules> = {
  [KEY in keyof RULES]: DecisionValue<RULES[KEY]["question"]>;
};

/**
 * How one answer resolved against its rule.
 *
 * @group Decision models
 */
export type ResolvedAnswer = {
  value: string | boolean | number;
  /** A yes-or-no answer is as confident as its more likely side. */
  confidence: number;
  /** True when the answer fell below the cutoff and `whenUnsure` was used. */
  unsure: boolean;
};

/**
 * Ask named questions about one state; each resolves to one value to act on.
 *
 * @example
 * ```ts
 * const { wake } = await decide({
 *   site: "pull-request-wake",
 *   state: { ci: "pending", newComments: [] },
 *   questions: { wake: { question: pullRequestWake, whenUnsure: "builder" } },
 * });
 * if (wake === "idle") return;
 * ```
 */
export async function decide<const RULES extends DecisionRules>(
  options: DecideOptions<RULES>,
  executeJev: ExecuteJevStep,
): Promise<Decided<RULES>> {
  const rules: DecisionRules = options.questions;
  for (const [key, rule] of Object.entries(rules)) {
    const cutoff = rule.cutoff ?? DECISION_CUTOFF;
    if (!(cutoff >= 0 && cutoff <= 1))
      throw new JigsError(`decision "${options.site}.${key}" needs a cutoff between 0 and 1`);
  }
  const result = await askJev(
    {
      model: options.model ?? jevModel,
      site: options.site,
      state: options.state,
      questions: Object.fromEntries(
        Object.entries(rules).map(([key, rule]) => [key, rule.question]),
      ),
      rules: Object.fromEntries(
        Object.entries(rules).map(([key, rule]) => [
          key,
          { whenUnsure: rule.whenUnsure, cutoff: rule.cutoff ?? DECISION_CUTOFF },
        ]),
      ),
    },
    executeJev,
  );
  const answers: Record<string, JevAnswer<JevQuestion>> = result.answers;
  // Object iteration erases the mapped keys; each value came from its own rule.
  return Object.fromEntries(
    Object.entries(rules).map(([key, rule]) => [key, resolveAnswer(rule, answers[key]).value]),
  ) as Decided<RULES>;
}

/** Resolve one answer against its rule, using `whenUnsure` below the cutoff. */
export function resolveAnswer(
  rule: { whenUnsure: string | boolean | number; cutoff?: number },
  answer: JevAnswer<JevQuestion> | undefined,
): ResolvedAnswer {
  if (answer === undefined) return { value: rule.whenUnsure, confidence: 0, unsure: true };
  const cutoff = rule.cutoff ?? DECISION_CUTOFF;
  const [value, confidence] =
    "probability" in answer
      ? [answer.probability >= 0.5, Math.max(answer.probability, 1 - answer.probability)]
      : "choice" in answer
        ? [answer.choice, answer.confidence]
        : [Math.round(answer.score), answer.confidence];
  return confidence >= cutoff
    ? { value, confidence, unsure: false }
    : { value: rule.whenUnsure, confidence, unsure: true };
}
