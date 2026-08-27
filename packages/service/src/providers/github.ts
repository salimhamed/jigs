// Called from inside "use step" functions and from the trigger-path
// preflight — never from a workflow body, where env reads and network are
// forbidden. GITHUB_API_URL override is a test seam.

import type { PrRef } from "../suspension/tokens";

export interface PrReview {
  id: number;
  state: string;
  body: string;
  user: string;
  submittedAt: string;
}

export interface ReviewComment {
  id: number;
  rootId: number;
  body: string;
  user: string;
  path: string;
  line: number | null;
  createdAt: string;
}

export interface ReviewThread {
  rootId: number;
  path: string;
  line: number | null;
  comments: ReviewComment[];
}

export interface CheckRun {
  name: string;
  conclusion: string | null;
  url: string;
}

export interface PrSnapshot {
  state: "open" | "closed";
  merged: boolean;
  headSha: string;
  // The authenticated login, so a consumer can tell its own comments from a
  // human's without guessing at bot names.
  viewer: string;
  reviews: PrReview[];
  reviewThreads: ReviewThread[];
  ci: "red" | "green" | "pending";
  failingChecks: CheckRun[];
}

async function githubRequest<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const token = process.env.GITHUB_TOKEN;
  if (token === undefined || token === "") {
    throw new Error("GITHUB_TOKEN is not set");
  }
  const base = process.env.GITHUB_API_URL ?? "https://api.github.com";
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`GitHub API ${res.status} on ${path}: ${await res.text()}`);
  }
  return (await res.json()) as T;
}

const githubGet = <T>(path: string): Promise<T> =>
  githubRequest<T>("GET", path);

// The preflight probe for GITHUB_TOKEN.
export async function getAuthenticatedUser(): Promise<{ login: string }> {
  return githubGet<{ login: string }>("/user");
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

export async function fetchPrSnapshot(pr: PrRef): Promise<PrSnapshot> {
  const repoPath = `/repos/${pr.owner}/${pr.repo}`;
  const prPath = `${repoPath}/pulls/${pr.number}`;
  const pull = await githubGet<{
    state: "open" | "closed";
    merged: boolean;
    head: { sha: string };
  }>(prPath);
  const reviews = await githubGet<
    Array<{
      id: number;
      state: string;
      body: string | null;
      user: { login: string } | null;
      submitted_at: string;
    }>
  >(`${prPath}/reviews?per_page=100`); // unpaginated cap, accepted for v0
  const comments = await githubGet<
    Array<{
      id: number;
      in_reply_to_id?: number | null;
      body: string | null;
      user: { login: string } | null;
      path?: string | null;
      line?: number | null;
      created_at: string;
    }>
  >(`${prPath}/comments?per_page=100`); // unpaginated cap, accepted for v0
  const checks = await githubGet<{
    check_runs: Array<{
      name: string;
      status: string;
      conclusion: string | null;
      html_url: string | null;
    }>;
  }>(`${repoPath}/commits/${pull.head.sha}/check-runs?per_page=100`); // unpaginated cap, accepted for v0
  const viewer = await getAuthenticatedUser();

  const runs: CheckRun[] = checks.check_runs.map((run) => ({
    name: run.name,
    conclusion: run.conclusion,
    url: run.html_url ?? "",
  }));
  const { ci, failing } = classifyChecks(
    runs,
    checks.check_runs.some((run) => run.status !== "completed"),
  );

  return {
    state: pull.state,
    merged: pull.merged,
    headSha: pull.head.sha,
    viewer: viewer.login,
    reviews: reviews.map((review) => ({
      id: review.id,
      state: review.state,
      body: review.body ?? "",
      user: review.user?.login ?? "unknown",
      submittedAt: review.submitted_at,
    })),
    reviewThreads: groupThreads(comments),
    ci,
    failingChecks: failing,
  };
}

export async function replyToReviewThread(
  pr: PrRef,
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
export async function postPrComment(
  pr: PrRef,
  body: string,
): Promise<{ id: number }> {
  return githubRequest<{ id: number }>(
    "POST",
    `/repos/${pr.owner}/${pr.repo}/issues/${pr.number}/comments`,
    { body },
  );
}

export interface CreatePullRequest {
  owner: string;
  repo: string;
  head: string;
  base: string;
  title: string;
  body: string;
}

export async function createPullRequest(
  request: CreatePullRequest,
): Promise<{ number: number }> {
  const { owner, repo, ...rest } = request;
  return githubRequest<{ number: number }>(
    "POST",
    `/repos/${owner}/${repo}/pulls`,
    rest,
  );
}

export async function squashMergePr(
  pr: PrRef,
  title: string,
): Promise<{ merged: boolean; sha: string }> {
  return githubRequest<{ merged: boolean; sha: string }>(
    "PUT",
    `/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/merge`,
    { merge_method: "squash", commit_title: title },
  );
}
