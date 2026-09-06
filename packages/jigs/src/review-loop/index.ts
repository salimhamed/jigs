// The review-loop building blocks: one function each, no options bag, no
// composition. The order they run in, the merge policy, the escalation prose
// and the prompts are the factory's — `jigs init` scaffolds the composition
// that calls these into `pipelines/review-loop.ts`, and the factory edits it
// (ADR 0009).
//
// What stays here is what a wrong edit would break rather than merely change:
// the builder's session pointer, the resume-first fallback, the ids the gate
// cursor needs back, and the code-review call that is never handed the brief.
//
// Every block takes the wrapper functions it needs as plain parameters and
// destructures them once, before calling: a `"use step"` wrapper reached as
// `options.readDiff(...)` is a step call whose receiver the SDK serializes
// along with its arguments, and that receiver is an object holding functions.
// `pull-request.ts` is not re-exported here — it reaches node builtins and is
// reached through `@salimhamed/jigs/review-loop/pull-request` from a step
// wrapper, never from the workflow side.

export {
  type AnswerAsBuilderOptions,
  answerAsBuilder,
  type PostAnswersOptions,
  postAnswers,
  type ThreadAnswers,
  threadAnswers,
} from "./builder.ts";
export {
  type CommitLeftoverWorkOptions,
  commitLeftoverWork,
} from "./commit.ts";
export {
  type DescribePrOptions,
  describePr,
  type PrDescription,
  prDescription,
} from "./describe-pr.ts";
export { type FixCiOptions, fixCi, renderChecks } from "./fix-ci.ts";
export {
  codeReviewVerdict,
  type ImplementAndReviewOptions,
  type ImplementAndReviewResult,
  implementAndReview,
} from "./implement.ts";
