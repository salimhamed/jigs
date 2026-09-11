// Temporary. This folder exists only so the folder move ships with no public
// API change: each file re-exports, by explicit name, exactly what one
// exports-map subpath exported before the move, from the blocks/ and steps/
// modules that content now lives in. Nothing shipped inside src/ imports this
// folder — only tsdown's entry list and the export-name check in
// package.test.ts point at it. The next PR replaces every subpath here with
// blocks/index.ts and steps/index.ts and deletes the folder whole.

export {
  classifyPrState,
  type GateAck,
  type GateCursor,
  type GateFn,
  type GateWake,
  PR_TOKEN_PREFIX,
  type PrRef,
  prToken,
  pullRequestGate,
  tokenFromGithubPayload,
} from "../blocks/pull-request/gate.ts";
export { fetchPrState } from "../steps/pull-request/fetch-state.ts";
