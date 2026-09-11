// Temporary. This folder exists only so the folder move ships with no public
// API change: each file re-exports, by explicit name, exactly what one
// exports-map subpath exported before the move, from the blocks/ and steps/
// modules that content now lives in. Nothing shipped inside src/ imports this
// folder — only tsdown's entry list and the export-name check in
// package.test.ts point at it. The next PR replaces every subpath here with
// blocks/index.ts and steps/index.ts and deletes the folder whole.

export { rebuildContextPrompt } from "../blocks/agent/rebuild-context.prompt.ts";
export { answerReviewPrompt } from "../blocks/builder-agent/answer-review.prompt.ts";
export { codeReviewPrompt } from "../blocks/builder-agent/code-review.prompt.ts";
export { commitWorkPrompt } from "../blocks/builder-agent/commit-work.prompt.ts";
export { fixCiPrompt } from "../blocks/builder-agent/fix-ci.prompt.ts";
export { fixCiFreshPrompt } from "../blocks/builder-agent/fix-ci-fresh.prompt.ts";
export { implementPrompt } from "../blocks/builder-agent/implement.prompt.ts";
export { interpolate } from "../blocks/interpolate.ts";
export { ticketReviewPrompt } from "../blocks/ticket/ticket-review.prompt.ts";
