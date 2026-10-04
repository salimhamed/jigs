import type { CheckRun, PullRequestRef, PullRequestSnapshot } from "../../providers/github.ts";
import type { commentOnPullRequest } from "../../steps/pull-requests/pr.ts";
import {
  assertUsableScope,
  type MarkerLedger,
  markBody,
  readLedger,
  type StatusReason,
} from "./marker.ts";
import type { FetchPrState } from "./pull-request.ts";
import { currentRunId } from "./writer.ts";

/** Inputs for posting one commit-scoped pull request status note. */
export interface PostPullRequestNoteOptions {
  /** Factory-owned step used to read what the pull request already records. */
  fetchPullRequestState: FetchPrState;
  /** Factory-owned step used to post on the pull request conversation. */
  commentOnPullRequest: typeof commentOnPullRequest;
  /** The pull request receiving the note. */
  pr: PullRequestRef;
  /** The continuation identity that owns the note. */
  scope: string;
  /** The commit the note is about: a red head, or a head it could not merge. */
  headSha: string;
  /** Labels the update so CI and merge notes for the same commit stay independent. */
  reason: StatusReason;
  /** The Markdown note body. */
  body: string;
}

// The one failure this module handles rather than raises: the write may have
// landed, so retrying it now could double-post, and failing the run would
// throw away a delivery the next wake can finish. Ending the wake is the
// cheapest correct thing to do.
function postFailed(pr: PullRequestRef, what: string, error: unknown): void {
  console.log(
    `[pullRequest] ${pr.owner}/${pr.repo}#${pr.number} could not post ${what}: ${String(error)} — ending this wake; the next one reposts it unless it landed`,
  );
}

// Every comment body on the pull request, wherever it hangs: the markers in
// them are the whole record of what jigs has done here.
function readPullRequestLedger(snapshot: PullRequestSnapshot, scope: string): MarkerLedger {
  return readLedger(
    [
      ...snapshot.reviews.map((review) => review.body),
      ...snapshot.reviewThreads.flatMap((thread) => thread.comments.map((comment) => comment.body)),
      ...snapshot.conversationComments.map((comment) => comment.body),
    ],
    scope,
  );
}

/**
 * Post a status note once per scope, commit and reason.
 *
 * @remarks
 * Reads current pull request comments and skips a note whose marker is already present.
 * A posting failure is logged and returns without throwing. The workflow decides whether
 * and when to try again; the note does not change merge readiness or schedule another action.
 */
export async function postPullRequestNote(options: PostPullRequestNoteOptions): Promise<void> {
  const { pr, headSha, reason } = options;
  assertUsableScope(options.scope);
  const ledger = readPullRequestLedger(await options.fetchPullRequestState(pr), options.scope);
  if (ledger.settled[reason].has(headSha)) return;
  try {
    await options.commentOnPullRequest(
      pr,
      markBody(options.body, [
        {
          scope: options.scope,
          run: currentRunId(),
          kind: "status",
          reason: options.reason,
          source: headSha,
        },
      ]),
    );
  } catch (error) {
    postFailed(pr, `the ${options.reason} note for ${headSha}`, error);
  }
}

/**
 * Render failed checks as a Markdown list for a pull request note.
 *
 * @group Pull requests
 */
export function renderChecks(failing: CheckRun[]): string {
  return failing.length === 0
    ? "_(the provider reported a red build without naming a check)_"
    : failing
        .map((check) => {
          // A commit status may carry no target_url at all, and a line
          // trailing off into an empty link reads as a broken one.
          const named = `- **${check.name}** — ${check.conclusion}`;
          return check.url === "" ? named : `${named} — ${check.url}`;
        })
        .join("\n");
}
