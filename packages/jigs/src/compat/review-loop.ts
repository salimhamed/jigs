// Temporary. This folder exists only so the folder move ships with no public
// API change: each file re-exports, by explicit name, exactly what one
// exports-map subpath exported before the move, from the blocks/ and steps/
// modules that content now lives in. Nothing inside src/ imports this folder —
// only tsdown's entry list points at it. The next PR replaces every subpath
// here with blocks/index.ts and steps/index.ts and deletes the folder whole.

export {
  type AnswerAsBuilderOptions,
  answerAsBuilder,
  type PostAnswersOptions,
  postAnswers,
  type ThreadAnswers,
  threadAnswers,
} from "../blocks/builder-agent/answer-review.ts";
export {
  type CommitLeftoverWorkOptions,
  commitLeftoverWork,
} from "../blocks/builder-agent/commit-work.ts";
export {
  type DescribePrOptions,
  describePr,
  type PrDescription,
  prDescription,
} from "../blocks/builder-agent/describe-pr.ts";
export {
  type FixCiOptions,
  fixCi,
  renderChecks,
} from "../blocks/builder-agent/fix-ci.ts";
export {
  codeReviewVerdict,
  type ImplementAndReviewOptions,
  type ImplementAndReviewResult,
  implementAndReview,
} from "../blocks/builder-agent/implement.ts";
