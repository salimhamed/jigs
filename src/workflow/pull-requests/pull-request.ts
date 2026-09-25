import type { PullRequestSnapshot } from "../../providers/github.ts";

/** The durable hook-token prefix for pull request activity. */
export const PULL_REQUEST_TOKEN_PREFIX = "github:pr:";

/**
 * Build the durable hook token shared by a pull request watcher, the service poll and the webhook ingress.
 *
 * @remarks
 * Owner and repository are lowercased because GitHub treats them
 * case-insensitively: a remote typed `acme/api` and a webhook naming `Acme/API`
 * are the same pull request and must produce the same token.
 */
export function pullRequestToken(pr: PullRequestRef): string {
  const slug = `${pr.owner}/${pr.repo}`.toLowerCase();
  return `${PULL_REQUEST_TOKEN_PREFIX}${slug}#${pr.number}`;
}

type GithubPayload = {
  pull_request?: { number?: unknown };
  // issue_comment fires for issues too; only a PR carries issue.pull_request.
  issue?: { number?: unknown; pull_request?: unknown };
  check_suite?: { pull_requests?: Array<{ number?: unknown }> };
  check_run?: { pull_requests?: Array<{ number?: unknown }> };
  repository?: { name?: unknown; owner?: { login?: unknown } };
};

function prNumber(payload: GithubPayload): number | null {
  const candidates = [
    payload.pull_request?.number,
    payload.issue?.pull_request === undefined ? undefined : payload.issue?.number,
    payload.check_suite?.pull_requests?.[0]?.number,
    payload.check_run?.pull_requests?.[0]?.number,
  ];
  const number = candidates.find((value) => typeof value === "number");
  return number ?? null;
}

/** Return the pull request hook token named by a supported GitHub webhook payload. */
export function tokenFromGitHubPayload(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const { repository } = payload as GithubPayload;
  const repo = repository?.name;
  const owner = repository?.owner?.login;
  const number = prNumber(payload as GithubPayload);
  if (number === null || typeof repo !== "string" || typeof owner !== "string") {
    return null;
  }
  return pullRequestToken({ owner, repo, number });
}

/** Identifies a pull request by repository owner, repository name and number. */
export type PullRequestRef = {
  /** The GitHub organization or account that owns the repository. */
  owner: string;
  /** The repository name. */
  repo: string;
  /** The repository-local pull request number. */
  number: number;
};

// Declared here rather than written as `typeof fetchPullRequestState`: declaring the
// contract in workflow/ typechecks the step against the routine and keeps this
// side free of any value import into steps/.
export type FetchPrState = (pr: PullRequestRef) => Promise<PullRequestSnapshot>;
