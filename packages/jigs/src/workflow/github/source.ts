import { z } from "zod";
import type { SourceDescriptor } from "../factory.ts";
import { installationNameSchema } from "../factory-schema.ts";
import type { PullRequestRef, RepositoryRef } from "../pull-requests/pull-request.ts";

export const GITHUB_PUSHES_SOURCE = "github.pushes";
export const GITHUB_PULL_REQUESTS_SOURCE = "github.pullRequests";
export const GITHUB_ISSUES_SOURCE = "github.issues";
export const GITHUB_RELEASES_SOURCE = "github.releases";

// An empty list would match nothing, which no one means.
const names = z.array(z.string().min(1)).min(1);

// What every GitHub source watches: one installation, and optionally some of its repositories.
const repositoryParams = {
  installationName: installationNameSchema,
  repositories: z
    .array(z.string().regex(/^[^/\s]+\/[^/\s]+$/, "must be owner/repo, such as acme/api"))
    .min(1)
    .optional(),
};

export const gitHubPushesParamsSchema = z.strictObject({
  ...repositoryParams,
  branches: names.optional(),
});

/**
 * Which pushes a `github.pushes` source starts runs for. Each list matches
 * any of its values; leaving one out does not filter on it.
 *
 * - `installationName`: the GitHub App installation, as named on the hub,
 *   whose repositories it watches.
 * - `repositories`: `owner/repo` names, such as `acme/api`, in any case.
 * - `branches`: branch names, such as `main`.
 *
 * @group Factory and workflows
 */
export type GitHubPushesParams = z.input<typeof gitHubPushesParamsSchema>;

/**
 * The inputs a `github.pushes` source hands each run it starts.
 *
 * @group Factory and workflows
 */
export type GitHubPushInputs = RepositoryRef & {
  /** The branch pushed to, such as `main`. */
  branch: string;
  /** The commit the branch pointed at before the push, all zeros for a new branch. */
  before: string;
  /** The commit the branch points at after the push. */
  after: string;
};

export const gitHubPullRequestsParamsSchema = z.strictObject({
  ...repositoryParams,
  authors: names.optional(),
  labels: names.optional(),
  baseBranches: names.optional(),
});

/**
 * Which pull requests a `github.pullRequests` source starts runs for. Each
 * list matches any of its values; leaving one out does not filter on it.
 *
 * - `installationName`: the GitHub App installation, as named on the hub,
 *   whose repositories it watches.
 * - `repositories`: `owner/repo` names, such as `acme/api`, in any case.
 * - `authors`: GitHub logins of who opened the pull request, such as
 *   `dependabot[bot]`.
 * - `labels`: label names; a pull request with any of them matches.
 * - `baseBranches`: the branches the pull request merges into, such as `main`.
 *
 * @group Factory and workflows
 */
export type GitHubPullRequestsParams = z.input<typeof gitHubPullRequestsParamsSchema>;

export const gitHubIssuesParamsSchema = z.strictObject({
  ...repositoryParams,
  authors: names.optional(),
  labels: names.optional(),
});

/**
 * Which issues a `github.issues` source starts runs for. Each list matches
 * any of its values; leaving one out does not filter on it.
 *
 * - `installationName`: the GitHub App installation, as named on the hub,
 *   whose repositories it watches.
 * - `repositories`: `owner/repo` names, such as `acme/api`, in any case.
 * - `authors`: GitHub logins of who opened the issue.
 * - `labels`: label names; an issue with any of them matches.
 *
 * @group Factory and workflows
 */
export type GitHubIssuesParams = z.input<typeof gitHubIssuesParamsSchema>;

/**
 * The inputs a `github.issues` source hands each run it starts.
 *
 * @group Factory and workflows
 */
export type GitHubIssueInputs = RepositoryRef & {
  /** The repository-local issue number. */
  number: number;
};

export const gitHubReleasesParamsSchema = z.strictObject(repositoryParams);

/**
 * Which releases a `github.releases` source starts runs for.
 *
 * - `installationName`: the GitHub App installation, as named on the hub,
 *   whose repositories it watches.
 * - `repositories`: `owner/repo` names, such as `acme/api`, in any case;
 *   leaving it out watches them all.
 *
 * @group Factory and workflows
 */
export type GitHubReleasesParams = z.input<typeof gitHubReleasesParamsSchema>;

/**
 * The inputs a `github.releases` source hands each run it starts.
 *
 * @group Factory and workflows
 */
export type GitHubReleaseInputs = RepositoryRef & {
  /** The release's tag, such as `v1.2.0`. */
  tag: string;
};

/**
 * Event-trigger sources on GitHub.
 *
 * @group Factory and workflows
 */
export const github = {
  /**
   * Start a run for each push to a branch, with {@link GitHubPushInputs} as
   * its inputs. Each push starts at most one run, ever. Tag pushes and
   * branch deletions start none. A push the factory's own GitHub App made,
   * such as merging a person's pull request, starts runs like any other.
   *
   * @remarks
   * The GitHub App must subscribe to the **Push** event.
   *
   * @example
   * ```ts
   * import { github } from "@jigs-ai/jigs";
   *
   * const source = github.pushes({
   *   installationName: "github-acme",
   *   repositories: ["acme/api"],
   *   branches: ["main"],
   * });
   * ```
   */
  pushes(params: GitHubPushesParams): SourceDescriptor {
    return { kind: GITHUB_PUSHES_SOURCE, params: { ...params } };
  },
  /**
   * Start a run for each pull request, with its {@link PullRequestRef} as
   * the inputs. A pull request starts at most one run, ever: the first time
   * any of its events shows it open, not a draft and matching the filters,
   * such as when it is opened, labeled or marked ready for review. A pull
   * request reopened after its run ended starts no new one; rerun it with
   * `jigs run`.
   *
   * @remarks
   * Events the factory's own GitHub App caused start no run, so a pull
   * request the App opens starts one only once a person acts on it, such as
   * by adding a label the trigger filters on.
   *
   * @example
   * ```ts
   * import { github } from "@jigs-ai/jigs";
   *
   * const source = github.pullRequests({
   *   installationName: "github-acme",
   *   repositories: ["acme/api"],
   *   authors: ["dependabot[bot]"],
   * });
   * ```
   */
  pullRequests(params: GitHubPullRequestsParams): SourceDescriptor {
    return { kind: GITHUB_PULL_REQUESTS_SOURCE, params: { ...params } };
  },
  /**
   * Start a run for each issue, with {@link GitHubIssueInputs} as its inputs.
   * An issue starts at most one run, ever: the first time any of its events
   * shows it open and matching the filters, such as when it is opened or
   * labeled. An issue reopened after its run ended starts no new one; rerun
   * it with `jigs run`.
   *
   * @remarks
   * The GitHub App must subscribe to the **Issues** event. Events the
   * factory's own GitHub App caused start no run, so an issue the App opens
   * starts one only once a person acts on it, such as by adding a label the
   * trigger filters on.
   *
   * @example
   * ```ts
   * import { github } from "@jigs-ai/jigs";
   *
   * const source = github.issues({
   *   installationName: "github-acme",
   *   repositories: ["acme/api"],
   *   labels: ["agent"],
   * });
   * ```
   */
  issues(params: GitHubIssuesParams): SourceDescriptor {
    return { kind: GITHUB_ISSUES_SOURCE, params: { ...params } };
  },
  /**
   * Start a run for each published release, with {@link GitHubReleaseInputs}
   * as its inputs. A release starts at most one run, ever. Drafts and
   * prereleases start none, nor does editing a release already published.
   *
   * @remarks
   * The GitHub App must subscribe to the **Release** event and needs
   * **Contents: read**.
   *
   * @example
   * ```ts
   * import { github } from "@jigs-ai/jigs";
   *
   * const source = github.releases({
   *   installationName: "github-acme",
   *   repositories: ["acme/api"],
   * });
   * ```
   */
  releases(params: GitHubReleasesParams): SourceDescriptor {
    return { kind: GITHUB_RELEASES_SOURCE, params: { ...params } };
  },
} as const;
