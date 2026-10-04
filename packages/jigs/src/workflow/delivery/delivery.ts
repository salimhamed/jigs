import type { pushApprovedChange, readWorktreeDiff } from "../../steps/git/branch.ts";
import type { createPullRequest, mergePullRequest } from "../../steps/pull-requests/pr.ts";
import type { registerResource } from "../../steps/runtime/resources.ts";
import type { AgentSession } from "../agents/agent-session.ts";
import type { ReadBranchState } from "../git/committed-work.ts";
import type { FetchPrState, PullRequestRef } from "../pull-requests/pull-request.ts";
import type { PullRequestSnapshot } from "../pull-requests/snapshot.ts";
import type { Worktree } from "../workspaces/worktree.ts";
import type { FindingResponse, ReviewFinding, ReviewRound } from "./answers.ts";

/**
 * One piece of work taken to a pull request: what to build, where, and the agents that build,
 * review and describe it.
 *
 * @remarks
 * `work` is yours: only your prompts read it. Give each delivery its own agent session objects: a
 * session holds its agent's conversation, and its name only labels log lines. `writer` describes
 * the pull request and defaults to `builder`. Each routine reads only some of these fields, so a
 * full delivery can be passed to all of them.
 *
 * @group Pull request delivery
 */
export interface Delivery<W> {
  work: W;
  /** One key per pull request: it scopes the hidden markers on that pull request's notes. */
  key: string;
  worktree: Worktree;
  prompts: DeliveryPrompts<W>;
  builder: AgentSession;
  reviewer: AgentSession;
  writer?: AgentSession | undefined;
}

/**
 * The prompts a delivery sends, written by the workflow. jigs adds only the line that tells each
 * agent the shape of its answer.
 *
 * @remarks
 * A turn with two forms goes to an agent session: `resume` is sent to an agent that holds the
 * earlier turns, so it says only what is new, and `fresh` to one starting from nothing, so it
 * says everything. `describe` is sent either way.
 *
 * @group Pull request delivery
 */
export interface DeliveryPrompts<W> {
  build: {
    fresh: (facts: BuildFacts<W>) => string;
    resume: (facts: { findings: ReviewFinding[] }) => string;
  };
  review: {
    fresh: (facts: ReviewFacts<W>) => string;
    resume: (facts: { headSha: string; diff: string; responses: FindingResponse[] }) => string;
  };
  describe: (facts: { work: W; worktree: Worktree; diff: string }) => string;
  maintain: {
    fresh: (facts: MaintainFacts & { work: W; worktree: Worktree; diff: string }) => string;
    resume: (facts: MaintainFacts) => string;
  };
}

/**
 * What a fresh build prompt is given: the open findings and the diff so far.
 *
 * @group Pull request delivery
 */
export interface BuildFacts<W> {
  work: W;
  worktree: Worktree;
  findings: ReviewFinding[];
  /** Empty before the first commit. */
  diff: string;
}

/**
 * What a fresh review prompt is given: the commit under review and every earlier round.
 *
 * @group Pull request delivery
 */
export interface ReviewFacts<W> {
  work: W;
  worktree: Worktree;
  headSha: string;
  diff: string;
  ledger: ReviewRound[];
}

/**
 * What a maintenance prompt is given: the pull request as GitHub reports it, and any local work
 * the builder has to recover first.
 *
 * @group Pull request delivery
 */
export interface MaintainFacts {
  pr: PullRequestRef;
  snapshot: PullRequestSnapshot;
  /**
   * The wake facts in `snapshot` the builder has not been shown, as the wake rule wrote them.
   * Empty when the turn only recovers local work.
   */
  news: string[];
  recovery?: UnpublishedWork | undefined;
}

/**
 * Local work the pull request has never had: uncommitted changes, or a local commit that was not
 * pushed. It holds back a merge until it is published.
 *
 * @group Pull request delivery
 */
export interface UnpublishedWork {
  dirty: boolean;
  localHead: string;
  pullRequestHead: string;
}

/**
 * The durable steps the delivery routines run.
 *
 * @group Factory plumbing
 */
export interface DeliverySteps {
  readBranchState: ReadBranchState;
  readWorktreeDiff: typeof readWorktreeDiff;
  pushApprovedChange: typeof pushApprovedChange;
  createPullRequest: typeof createPullRequest;
  registerResource: typeof registerResource;
  fetchPullRequestState: FetchPrState;
  mergePullRequest: typeof mergePullRequest;
}

// Facts that can end up posted anywhere can quote agent
// text, so the worktree path is replaced in them; `jigs status` shows it to the
// operator. Raw git and library errors are never put in them, as they can name
// other local paths.
export const withoutLocalPath = (worktree: Worktree, text: string) =>
  text.replaceAll(worktree.path, "the run's worktree");
