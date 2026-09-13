// Called from inside "use step" functions and from the trigger-path
// preflight — never from a workflow body, where env reads and network are
// forbidden. GITHUB_API_URL override is a test seam.

export type PrRef = {
  owner: string;
  repo: string;
  number: number;
};

export interface PrReview {
  id: number;
  state: string;
  body: string;
  user: string;
  submittedAt: string;
  commitSha?: string;
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
  // Absent on an inline thread. A conversation thread is synthetic — a review
  // summary or a pull request conversation comment — and has no file anchor,
  // so an answer to it is posted on the conversation, not as a thread reply.
  origin?: "conversation";
}

/** A comment on the pull request conversation, which hangs off no thread. */
export interface PrComment {
  id: number;
  body: string;
  user: string;
  // GitHub's own account kind — "User", "Bot" or "Organization". Not the self
  // guard, which is exact-id: a human and jigs are both "User" here.
  userType: string;
  createdAt: string;
  // An edit is how a reviewer adds to a comment that has no thread to reply
  // into, so the gate keys its cursor on this as well as the id.
  updatedAt: string;
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
  // The authenticated login. Never proof of authorship: a factory on its
  // operator's personal token has the operator as the viewer, so nothing may
  // read "the viewer wrote it" as "jigs wrote it".
  viewer: string;
  reviews: PrReview[];
  reviewThreads: ReviewThread[];
  conversationComments: PrComment[];
  ci: "red" | "green" | "pending";
  failingChecks: CheckRun[];
}

async function githubRequest<T>(method: string, path: string, body?: unknown): Promise<T> {
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

const githubGet = <T>(path: string): Promise<T> => githubRequest<T>("GET", path);

// GitHub caps a page at 100 and a short page is the last one. The ceiling is
// not a real pull request's size — it is the stop for a proxy that answers
// every page with a full one, which would otherwise spin a step forever.
const MAX_PAGES = 50;

async function githubGetAll<T>(path: string): Promise<T[]> {
  const join = path.includes("?") ? "&" : "?";
  const all: T[] = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const batch = await githubGet<T[]>(`${path}${join}per_page=100&page=${page}`);
    all.push(...batch);
    if (batch.length < 100) return all;
  }
  throw new Error(`GitHub kept returning full pages of ${path} past ${MAX_PAGES} pages`);
}

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
  const viewer = await getAuthenticatedUser();

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
    headSha: pull.head.sha,
    viewer: viewer.login,
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
export async function postPrComment(pr: PrRef, body: string): Promise<{ id: number }> {
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

export async function createPullRequest(request: CreatePullRequest): Promise<{ number: number }> {
  const { owner, repo, ...rest } = request;
  return githubRequest<{ number: number }>("POST", `/repos/${owner}/${repo}/pulls`, rest);
}

export async function fetchPrTitle(pr: PrRef): Promise<string> {
  const pull = await githubGet<{ title: string }>(
    `/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}`,
  );
  return pull.title;
}

export async function squashMergePr(
  pr: PrRef,
  title: string,
  expectedHeadSha?: string,
): Promise<{ merged: boolean; sha: string }> {
  return githubRequest<{ merged: boolean; sha: string }>(
    "PUT",
    `/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/merge`,
    {
      merge_method: "squash",
      commit_title: title,
      ...(expectedHeadSha === undefined ? {} : { sha: expectedHeadSha }),
    },
  );
}
