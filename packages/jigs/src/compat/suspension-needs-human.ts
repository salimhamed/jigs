// Temporary. This folder exists only so the folder move ships with no public
// API change: each file re-exports, by explicit name, exactly what one
// exports-map subpath exported before the move, from the blocks/ and steps/
// modules that content now lives in. Nothing inside src/ imports this folder —
// only tsdown's entry list points at it. The next PR replaces every subpath
// here with blocks/index.ts and steps/index.ts and deletes the folder whole.

export {
  type HumanReply,
  type JsonValue,
  NEEDS_HUMAN_TOKEN_PREFIX,
  type NeedsHumanDeps,
  type NeedsHumanFn,
  needsHuman,
  needsHumanToken,
} from "../blocks/ticket/halt-for-human.ts";
export {
  checkForHumanReply,
  postNeedsHumanComment,
} from "../steps/ticket/needs-human-comments.ts";
