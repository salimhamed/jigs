import { JigsError } from "../../errors.ts";
import { models, type OpenrouterSource } from "./harness-config.ts";
import {
  askJev,
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
 * One named decision: a single question, the evidence, and how sure the answer must be.
 *
 * @group Decision models
 */
export type DecideOptions<QUESTION extends JevQuestion> = {
  /** A stable name for this decision point, recorded with every answer. */
  site: string;
  state: JevState;
  question: QUESTION;
  /** The confidence, from 0 to 1, at or above which the answer counts as confident. */
  cutoff: number;
  model?: OpenrouterSource;
};

/**
 * A decision's answer, with whether it cleared its cutoff.
 *
 * @group Decision models
 *
 * @remarks
 * A yes-or-no answer's confidence is the probability of whichever side is more likely,
 * and `yes` is true when yes is the more likely side.
 */
export type Decision<QUESTION extends JevQuestion> = {
  confident: boolean;
  confidence: number;
  answer: JevAnswer<QUESTION>;
} & (QUESTION extends YesNoQuestion ? { yes: boolean } : unknown);

/** Ask one decision question and report whether the answer clears its cutoff. */
export async function decide<const QUESTION extends JevQuestion>(
  options: DecideOptions<QUESTION>,
  executeJev: ExecuteJevStep,
): Promise<Decision<QUESTION>> {
  if (!(options.cutoff >= 0 && options.cutoff <= 1))
    throw new JigsError(`decision "${options.site}" needs a cutoff between 0 and 1`);
  const result = await askJev(
    {
      model: options.model ?? jevModel,
      site: options.site,
      state: options.state,
      questions: { decision: options.question },
    },
    executeJev,
  );
  const answer = result.answers.decision;
  if ("probability" in answer) {
    const confidence = Math.max(answer.probability, 1 - answer.probability);
    // The conditional type cannot be narrowed from a runtime check on the answer.
    return {
      confident: confidence >= options.cutoff,
      confidence,
      answer,
      yes: answer.probability >= 0.5,
    } as Decision<QUESTION>;
  }
  return {
    confident: answer.confidence >= options.cutoff,
    confidence: answer.confidence,
    answer,
  } as Decision<QUESTION>;
}
