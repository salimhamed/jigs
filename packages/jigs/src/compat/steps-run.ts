// Temporary. This folder exists only so the folder move ships with no public
// API change: each file re-exports, by explicit name, exactly what one
// exports-map subpath exported before the move, from the blocks/ and steps/
// modules that content now lives in. Nothing inside src/ imports this folder —
// only tsdown's entry list points at it. The next PR replaces every subpath
// here with blocks/index.ts and steps/index.ts and deletes the folder whole.

export {
  type ExecuteDeps,
  realDeps,
  runAgent,
} from "../steps/agent/run-agent.ts";
export { runAsk } from "../steps/agent/run-ask.ts";
