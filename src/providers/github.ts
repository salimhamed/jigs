// Called from inside "use step" functions and from the trigger-path
// preflight — never from a workflow body, where env reads and network are
// forbidden. The credential comes from github-auth.ts, whichever identity the
// factory configured.

import type {
  CheckRun,
  PullRequestSnapshot,
  ReviewComment,
  ReviewThread,
} from "../workflow/pull-requests/snapshot.ts";

export type {
  CheckRun,
  PullRequestComment,
  PullRequestReview,
  PullRequestSnapshot,
  ReviewComment,
  ReviewThread,
} from "../workflow/pull-requests/snapshot.ts";

import type { MergePolicy } from "../workflow/pull-requests/policy.ts";
import { GithubApiError, githubGet, githubGetAll, githubRequest } from "./github-api.ts";

export type PullRequestRef = {
  owner: string;
  repo: string;
  number: number;
};

// The preflight probe for a personal access token. It does not answer for an
// installation token, which is why the App identity names its operator.
export async function getAuthenticatedUser(): Promise<{ login: string }> {
  return githubGet<{ login: string }>("/user");
}

/** Resolve a commit-status delivery to every open PR currently headed by that commit. */
export async function findOpenPullRequestsByHeadSha(
  repository: Pick<PullRequestRef, "owner" | "repo">,
  sha: string,
): Promise<PullRequestRef[]> {
  const pulls = await githubGetAll<{
    number: number;
    state: string;
    head: { sha: string };
    base: { repo: { name: string; owner: { login: string } } };
  }>(`/repos/${repository.owner}/${repository.repo}/commits/${sha}/pulls`);
  return pulls
    .filter((pull) => pull.state === "open" && pull.head.sha === sha)
    .map((pull) => ({
      owner: pull.base.repo.owner.login,
      repo: pull.base.repo.name,
      number: pull.number,
    }));
}

/**
 * The open pull request already headed by a branch, or null.
 *
 * Closed and merged pull requests are out of scope by construction: a closed
 * one means a human decided, so a fresh pull request is the right answer. A
 * head outside this repository is never adopted — GitHub's `head=owner:branch`
 * filter names only the owner, so a sibling repository or a fork under the same
 * owner can come back and has to be rejected here.
 */
export async function findOpenPullRequestByBranch(
  repository: Pick<PullRequestRef, "owner" | "repo">,
  head: string,
  base: string,
): Promise<(PullRequestRef & { url: string }) | null> {
  const query = new URLSearchParams({
    state: "open",
    head: `${repository.owner}:${head}`,
    base,
  });
  const pulls = await githubGetAll<{
    number: number;
    state: string;
    html_url: string;
    head: { ref: string; repo: { full_name: string } | null };
    base: { ref: string; repo: { full_name: string } };
  }>(`/repos/${repository.owner}/${repository.repo}/pulls?${query.toString()}`);
  // Owner logins and repository names are case-insensitive on GitHub; branch
  // names are not.
  const fullName = `${repository.owner}/${repository.repo}`.toLowerCase();
  const isThisRepo = (repo: { full_name: string } | null) =>
    repo?.full_name.toLowerCase() === fullName;
  const matches = pulls.filter(
    (pull) =>
      pull.state === "open" &&
      pull.head.ref === head &&
      pull.base.ref === base &&
      isThisRepo(pull.head.repo) &&
      isThisRepo(pull.base.repo),
  );
  if (matches.length > 1) {
    throw new Error(
      `GitHub reports ${matches.length} open pull requests for ${repository.owner}/${repository.repo} ${head} into ${base}: ${matches.map((pull) => `#${pull.number}`).join(", ")}`,
    );
  }
  const [match] = matches;
  if (match === undefined) return null;
  return {
    owner: repository.owner,
    repo: repository.repo,
    number: match.number,
    url: match.html_url,
  };
}

// A completed run in any of these is a red build; everything else that
// completed counts as green.
const RED_CONCLUSIONS = new Set([
  "failure",
  "timed_out",
  "cancelled",
  "action_required",
  "startup_failure",
]);

// Some CI reports only through the legacy commit status API — AWS CodeBuild
// among them. An unrecognised state stays pending: a build jigs cannot read
// must never pass for green.
const STATUS_CONCLUSIONS = new Map<string, string | null>([
  ["success", "success"],
  ["failure", "failure"],
  ["error", "failure"],
  ["pending", null],
]);

function classifyChecks(runs: CheckRun[], anyPending: boolean) {
  const failing = runs.filter(
    (run) => run.conclusion !== null && RED_CONCLUSIONS.has(run.conclusion),
  );
  if (failing.length > 0) return { ci: "red" as const, failing };
  if (anyPending) return { ci: "pending" as const, failing };
  // Zero runs reads as pending, never green: a repo with no CI must never
  // escalate, and it has nothing to recover from either.
  return {
    ci: runs.length === 0 ? ("pending" as const) : ("green" as const),
    failing,
  };
}

// Threads are the inline review comments grouped by the root each reply hangs
// off, in the API's own order.
function groupThreads(
  comments: Array<{
    id: number;
    in_reply_to_id?: number | null;
    body: string | null;
    user: { login: string } | null;
    path?: string | null;
    line?: number | null;
    created_at: string;
    updated_at: string;
  }>,
): ReviewThread[] {
  const byRoot = new Map<number, ReviewThread>();
  for (const raw of comments) {
    const rootId = raw.in_reply_to_id ?? raw.id;
    const comment: ReviewComment = {
      id: raw.id,
      rootId,
      body: raw.body ?? "",
      user: raw.user?.login ?? "unknown",
      path: raw.path ?? "",
      line: raw.line ?? null,
      createdAt: raw.created_at,
      updatedAt: raw.updated_at,
    };
    const thread = byRoot.get(rootId);
    if (thread === undefined) {
      byRoot.set(rootId, {
        rootId,
        path: comment.path,
        line: comment.line,
        comments: [comment],
      });
    } else {
      thread.comments.push(comment);
    }
  }
  return [...byRoot.values()];
}

export async function fetchPrSnapshot(pr: PullRequestRef): Promise<PullRequestSnapshot> {
  const repoPath = `/repos/${pr.owner}/${pr.repo}`;
  const prPath = `${repoPath}/pulls/${pr.number}`;
  const pull = await githubGet<{
    state: "open" | "closed";
    merged: boolean;
    draft?: boolean;
    mergeable_state?: string | null;
    merge_commit_sha?: string | null;
    labels?: Array<{ name: string }>;
    head: { sha: string };
  }>(prPath);
  const reviews = await githubGetAll<{
    id: number;
    state: string;
    body: string | null;
    user: { login: string } | null;
    submitted_at: string;
    commit_id?: string;
  }>(`${prPath}/reviews`);
  const comments = await githubGetAll<{
    id: number;
    in_reply_to_id?: number | null;
    body: string | null;
    user: { login: string } | null;
    path?: string | null;
    line?: number | null;
    created_at: string;
    updated_at: string;
  }>(`${prPath}/comments`);
  // The conversation, where a review the operator cannot formally submit —
  // GitHub refuses approve and request-changes on one's own pull request —
  // lands instead. Issues and pull requests share this collection.
  const conversation = await githubGetAll<{
    id: number;
    body: string | null;
    user: { login: string; type?: string } | null;
    created_at: string;
    updated_at: string;
  }>(`${repoPath}/issues/${pr.number}/comments`);
  const checks = await githubGet<{
    check_runs: Array<{
      name: string;
      conclusion: string | null;
      html_url: string | null;
    }>;
  }>(`${repoPath}/commits/${pull.head.sha}/check-runs?per_page=100`); // unpaginated cap, accepted for v0
  const combined = await githubGet<{
    statuses: Array<{
      context: string;
      state: string;
      target_url: string | null;
    }>;
  }>(`${repoPath}/commits/${pull.head.sha}/status?per_page=100`); // unpaginated cap, accepted for v0

  const runs: CheckRun[] = checks.check_runs.map((run) => ({
    name: run.name,
    conclusion: run.conclusion,
    url: run.html_url ?? "",
  }));
  // A context on both surfaces is one build reported twice, and the check run
  // is the richer report. Two check runs of one name are two builds, and both
  // stay: a red one must not vanish behind a green namesake.
  const alsoACheckRun = new Set(runs.map((run) => run.name));
  const reported = [
    ...runs,
    ...combined.statuses
      .filter((status) => !alsoACheckRun.has(status.context))
      .map((status) => ({
        name: status.context,
        conclusion: STATUS_CONCLUSIONS.get(status.state) ?? null,
        url: status.target_url ?? "",
      })),
  ];
  const { ci, failing } = classifyChecks(
    reported,
    reported.some((run) => run.conclusion === null),
  );

  return {
    state: pull.state,
    merged: pull.merged,
    draft: pull.draft ?? false,
    // A missing field is not a clean one: an absent verdict reads as unknown,
    // which is "recheck on the next wake".
    mergeState: pull.mergeable_state ?? "unknown",
    labels: (pull.labels ?? []).map((label) => label.name),
    mergeCommitSha: pull.merge_commit_sha ?? null,
    headSha: pull.head.sha,
    reviews: reviews.map((review) => ({
      id: review.id,
      state: review.state,
      body: review.body ?? "",
      user: review.user?.login ?? "unknown",
      submittedAt: review.submitted_at,
      ...(review.commit_id === undefined ? {} : { commitSha: review.commit_id }),
    })),
    reviewThreads: groupThreads(comments),
    conversationComments: conversation.map((comment) => ({
      id: comment.id,
      body: comment.body ?? "",
      user: comment.user?.login ?? "unknown",
      // A deleted author reads as a person: a dropped wake is worse than one
      // the builder decides is noise.
      userType: comment.user?.type ?? "User",
      createdAt: comment.created_at,
      updatedAt: comment.updated_at,
    })),
    ci,
    failingChecks: failing,
  };
}

export async function replyToReviewThread(
  pr: PullRequestRef,
  rootId: number,
  body: string,
): Promise<{ id: number }> {
  return githubRequest<{ id: number }>(
    "POST",
    `/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/comments/${rootId}/replies`,
    { body },
  );
}

// The PR conversation, not a thread: what a review-body answer and the CI
// escalation both land on.
export async function postPrComment(pr: PullRequestRef, body: string): Promise<{ id: number }> {
  return githubRequest<{ id: number }>(
    "POST",
    `/repos/${pr.owner}/${pr.repo}/issues/${pr.number}/comments`,
    { body },
  );
}

export interface PullRequestReviewRequest {
  event: "comment" | "approve" | "request-changes";
  body: string;
  comments?: Array<{ path: string; line: number; body: string }>;
}

const REVIEW_EVENTS = {
  comment: "COMMENT",
  approve: "APPROVE",
  "request-changes": "REQUEST_CHANGES",
} as const satisfies Record<PullRequestReviewRequest["event"], string>;

export async function postPullRequestReview(
  pr: PullRequestRef,
  review: PullRequestReviewRequest,
): Promise<{ id: number }> {
  return githubRequest<{ id: number }>(
    "POST",
    `/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/reviews`,
    {
      event: REVIEW_EVENTS[review.event],
      body: review.body,
      ...(review.comments === undefined || review.comments.length === 0
        ? {}
        : {
            comments: review.comments.map(({ path, line, body }) => ({
              path,
              line,
              side: "RIGHT",
              body,
            })),
          }),
    },
  );
}

export interface CreatePullRequest {
  owner: string;
  repo: string;
  head: string;
  base: string;
  title: string;
  body: string;
  draft?: boolean;
}

/** Mark a draft pull request ready for review. Safe when it is already ready. */
export async function markPrReady(pr: PullRequestRef): Promise<void> {
  // The ready-for-review mutation requires a node id, so resolve it through
  // the existing REST pull-request endpoint before calling GraphQL.
  const { node_id: pullRequestId } = await githubGet<{ node_id: string }>(
    `/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}`,
  );
  const result = await githubRequest<{ errors?: Array<{ message: string }> }>(
    "POST",
    "/graphql",
    {
      query: `mutation MarkPullRequestReadyForReview($pullRequestId: ID!) {
      markPullRequestReadyForReview(input: { pullRequestId: $pullRequestId }) {
        pullRequest { id }
      }
    }`,
      variables: { pullRequestId },
    },
    pr.owner,
  );
  if (result.errors !== undefined && result.errors.length > 0) {
    throw new GithubApiError(
      200,
      "/graphql",
      result.errors.map(({ message }) => message).join("; "),
    );
  }
}

export async function createPullRequest(
  request: CreatePullRequest,
): Promise<{ number: number; html_url: string }> {
  const { owner, repo, ...rest } = request;
  return githubRequest<{ number: number; html_url: string }>(
    "POST",
    `/repos/${owner}/${repo}/pulls`,
    rest,
  );
}

/** The commit messages on the branch, in the order GitHub lists them. */
export async function fetchPrCommitMessages(pr: PullRequestRef): Promise<string[]> {
  const commits = await githubGetAll<{ commit: { message: string } }>(
    `/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/commits`,
  );
  return commits.map((entry) => entry.commit.message);
}

export async function fetchPrTitle(pr: PullRequestRef): Promise<string> {
  const pull = await githubGet<{ title: string }>(
    `/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}`,
  );
  return pull.title;
}

export interface MergeRequest {
  title: string;
  /** The head the caller judged ready; GitHub refuses the merge if it has moved. */
  expectedHeadSha: string;
  method: MergePolicy["method"];
  /** The squash or merge commit body jigs supplies when one is required. */
  message?: string;
}

// PUT, and `sha` is the guard: GitHub answers 409 rather than merging a commit
// the caller never saw. A rebase rewrites the commits, so it takes no message.
export async function mergePr(
  pr: PullRequestRef,
  request: MergeRequest,
): Promise<{ merged: boolean; sha: string }> {
  return githubRequest<{ merged: boolean; sha: string }>(
    "PUT",
    `/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/merge`,
    {
      merge_method: request.method,
      sha: request.expectedHeadSha,
      ...(request.method === "rebase"
        ? {}
        : {
            commit_title: request.title,
            ...(request.message === undefined ? {} : { commit_message: request.message }),
          }),
    },
  );
}

/** Put the operator's name on a pull request the App opened for them. */
export async function assignPullRequest(pr: PullRequestRef, logins: string[]): Promise<void> {
  await githubRequest("POST", `/repos/${pr.owner}/${pr.repo}/issues/${pr.number}/assignees`, {
    assignees: logins,
  });
}
