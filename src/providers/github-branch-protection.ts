import { GithubApiError, githubGet, githubRequest } from "./github-api.ts";
import type { GithubRepoRef } from "./github-webhook.ts";

export interface BranchProtection {
  protected: boolean;
  requiredChecks: string[];
  strictChecks: boolean;
  requiredApprovingReviews: number;
}

interface GithubProtection {
  required_status_checks?: {
    strict?: boolean;
    contexts?: string[];
    checks?: Array<{ context: string }>;
  } | null;
  required_pull_request_reviews?: {
    required_approving_review_count?: number;
    dismiss_stale_reviews?: boolean;
    require_code_owner_reviews?: boolean;
    require_last_push_approval?: boolean;
    dismissal_restrictions?: {
      users?: Array<{ login: string }>;
      teams?: Array<{ slug: string }>;
      apps?: Array<{ slug: string }>;
    };
  } | null;
  enforce_admins?: { enabled?: boolean } | null;
  restrictions?: {
    users?: Array<{ login: string }>;
    teams?: Array<{ slug: string }>;
    apps?: Array<{ slug: string }>;
  } | null;
  required_linear_history?: { enabled?: boolean };
  allow_force_pushes?: { enabled?: boolean };
  allow_deletions?: { enabled?: boolean };
  block_creations?: { enabled?: boolean };
  required_conversation_resolution?: { enabled?: boolean };
  lock_branch?: { enabled?: boolean };
  allow_fork_syncing?: { enabled?: boolean };
}

export interface GithubBranchProtection extends BranchProtection {
  raw?: GithubProtection;
}

const branchPath = ({ owner, repo }: GithubRepoRef, branch: string) =>
  `/repos/${owner}/${repo}/branches/${encodeURIComponent(branch)}/protection`;

export async function getBranchProtection(
  repo: GithubRepoRef,
  branch: string,
): Promise<GithubBranchProtection> {
  let raw: GithubProtection;
  try {
    raw = await githubGet<GithubProtection>(branchPath(repo, branch));
  } catch (error) {
    if (error instanceof GithubApiError && error.status === 404) {
      return {
        protected: false,
        requiredChecks: [],
        strictChecks: false,
        requiredApprovingReviews: 0,
      };
    }
    throw error;
  }
  const checks = raw.required_status_checks;
  return {
    protected: true,
    requiredChecks: [
      ...new Set([...(checks?.contexts ?? []), ...(checks?.checks ?? []).map((c) => c.context)]),
    ].sort(),
    strictChecks: checks?.strict ?? false,
    requiredApprovingReviews:
      raw.required_pull_request_reviews?.required_approving_review_count ?? 0,
    raw,
  };
}

export async function defaultBranch(repo: GithubRepoRef): Promise<string> {
  return (await githubGet<{ default_branch: string }>(`/repos/${repo.owner}/${repo.repo}`))
    .default_branch;
}

export async function observedChecks(repo: GithubRepoRef, branch: string): Promise<string[]> {
  const ref = encodeURIComponent(branch);
  const base = `/repos/${repo.owner}/${repo.repo}/commits/${ref}`;
  const [runs, statuses] = await Promise.all([
    githubGet<{ check_runs: Array<{ name: string }> }>(`${base}/check-runs?per_page=100`),
    githubGet<{ statuses: Array<{ context: string }> }>(`${base}/status?per_page=100`),
  ]);
  return [
    ...new Set([
      ...runs.check_runs.map((run) => run.name),
      ...statuses.statuses.map((status) => status.context),
    ]),
  ].sort();
}

export async function putBranchProtection(
  repo: GithubRepoRef,
  branch: string,
  current: GithubBranchProtection,
  desired: BranchProtection,
): Promise<void> {
  const raw = current.raw;
  const reviews = raw?.required_pull_request_reviews;
  await githubRequest("PUT", branchPath(repo, branch), {
    required_status_checks: { strict: desired.strictChecks, contexts: desired.requiredChecks },
    enforce_admins: raw?.enforce_admins?.enabled ?? false,
    required_pull_request_reviews:
      desired.requiredApprovingReviews === 0
        ? null
        : {
            dismiss_stale_reviews: reviews?.dismiss_stale_reviews ?? false,
            require_code_owner_reviews: reviews?.require_code_owner_reviews ?? false,
            require_last_push_approval: reviews?.require_last_push_approval ?? false,
            dismissal_restrictions: {
              users: reviews?.dismissal_restrictions?.users?.map((user) => user.login) ?? [],
              teams: reviews?.dismissal_restrictions?.teams?.map((team) => team.slug) ?? [],
              apps: reviews?.dismissal_restrictions?.apps?.map((app) => app.slug) ?? [],
            },
            required_approving_review_count: desired.requiredApprovingReviews,
          },
    restrictions:
      raw?.restrictions == null
        ? null
        : {
            users: raw.restrictions.users?.map((user) => user.login) ?? [],
            teams: raw.restrictions.teams?.map((team) => team.slug) ?? [],
            apps: raw.restrictions.apps?.map((app) => app.slug) ?? [],
          },
    required_linear_history: raw?.required_linear_history?.enabled ?? false,
    allow_force_pushes: raw?.allow_force_pushes?.enabled ?? false,
    allow_deletions: raw?.allow_deletions?.enabled ?? false,
    block_creations: raw?.block_creations?.enabled ?? false,
    required_conversation_resolution: raw?.required_conversation_resolution?.enabled ?? false,
    lock_branch: raw?.lock_branch?.enabled ?? false,
    allow_fork_syncing: raw?.allow_fork_syncing?.enabled ?? false,
  });
}
