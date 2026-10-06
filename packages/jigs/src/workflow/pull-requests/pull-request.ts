import type { PullRequestSnapshot } from "../../providers/github.ts";
import { PULL_REQUEST_TOKEN_PREFIX } from "../hook-tokens.ts";
import type { ApprovalCoverage } from "./policy.ts";

/**
 * Build the durable hook token shared by a pull request watcher and the GitHub events that wake it.
 *
 * @remarks
 * Owner and repository are lowercased because GitHub treats them
 * case-insensitively: a remote typed `acme/api` and a webhook naming `Acme/API`
 * are the same pull request and must produce the same token.
 */
export function pullRequestToken(pr: PullRequestRef): string {
  const slug = `${pr.owner}/${pr.repo}`.toLowerCase();
  return `${PULL_REQUEST_TOKEN_PREFIX}${pr.installationName}:${slug}#${pr.number}`;
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

/** Return the pull request hook token named by a supported GitHub event payload from an installation. */
export function tokenFromGitHubPayload(installationName: string, payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const { repository } = payload as GithubPayload;
  const repo = repository?.name;
  const owner = repository?.owner?.login;
  const number = prNumber(payload as GithubPayload);
  if (number === null || typeof repo !== "string" || typeof owner !== "string") {
    return null;
  }
  return pullRequestToken({ installationName, owner, repo, number });
}

/**
 * Identifies a repository, and the GitHub installation jigs reaches it through.
 *
 * @group Pull requests
 */
export type RepositoryRef = {
  /** The name of the GitHub App installation, as named on the hub, that jigs acts through. */
  installationName: string;
  /** The GitHub organization or account that owns the repository. */
  owner: string;
  /** The repository name. */
  repo: string;
};

/**
 * Identifies a pull request by its repository, the installation jigs reaches it through, and its number.
 *
 * @group Pull requests
 */
export type PullRequestRef = RepositoryRef & {
  /** The repository-local pull request number. */
  number: number;
};

// Declared here rather than written as `typeof fetchPullRequestState`: declaring the
// contract in workflow/ typechecks the step against the routine and keeps this
// side free of any value import into steps/.
export type FetchPrState = (
  pr: PullRequestRef,
  options?: PullRequestReadOptions,
) => Promise<PullRequestSnapshot>;

/**
 * How workflow code asks for a pull request's approval to be read.
 *
 * @group Pull requests
 */
export interface PullRequestReadOptions {
  /** Which commits an approving review covers. Default `"latest-commit"`. */
  approvalCovers?: ApprovalCoverage;
}
