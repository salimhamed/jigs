// The GitHub sources, read off the webhooks the hub passes on under GitHub's
// event name. A push to a branch is one occurrence, keyed by the branch and
// the commits it moved from and to; a pull request or an issue is one, keyed
// by its number; a release is one, keyed by its tag.

import { z } from "zod";
import { githubAuthFor } from "../providers/github-auth.ts";
import {
  GITHUB_ISSUES_SOURCE,
  GITHUB_PULL_REQUESTS_SOURCE,
  GITHUB_PUSHES_SOURCE,
  GITHUB_RELEASES_SOURCE,
  type GitHubIssueInputs,
  type GitHubIssuesParams,
  type GitHubPullRequestsParams,
  type GitHubPushesParams,
  type GitHubPushInputs,
  type GitHubReleaseInputs,
  type GitHubReleasesParams,
  gitHubIssuesParamsSchema,
  gitHubPullRequestsParamsSchema,
  gitHubPushesParamsSchema,
  gitHubReleasesParamsSchema,
} from "../workflow/github/source.ts";
import type { PullRequestRef } from "../workflow/pull-requests/pull-request.ts";
import type { Source } from "./event-triggers/sources.ts";

const BRANCH_REF = "refs/heads/";

// Only what the occurrences and the filters read; GitHub sends more.
const repositorySchema = z.object({
  name: z.string().min(1),
  owner: z.object({ login: z.string().min(1) }),
});

const pushSchema = z.object({
  ref: z.string(),
  before: z.string(),
  after: z.string(),
  deleted: z.boolean(),
  repository: repositorySchema.extend({
    // Epoch seconds in a push event, unlike the ISO times other events carry.
    pushed_at: z.number(),
  }),
});

const issueSchema = z.object({
  number: z.number(),
  state: z.string(),
  updated_at: z.iso.datetime({ offset: true }),
  user: z.object({ login: z.string() }),
  labels: z.array(z.object({ name: z.string() })),
});

const pullRequestEventSchema = z.object({
  pull_request: issueSchema.extend({
    draft: z.boolean(),
    base: z.object({ ref: z.string() }),
  }),
  repository: repositorySchema,
  sender: z.object({ id: z.number() }),
});

const issueEventSchema = z.object({
  issue: issueSchema,
  repository: repositorySchema,
  sender: z.object({ id: z.number() }),
});

const releaseEventSchema = z.object({
  action: z.string(),
  release: z.object({
    tag_name: z.string(),
    draft: z.boolean(),
    prerelease: z.boolean(),
    published_at: z.iso.datetime({ offset: true }),
  }),
  repository: repositorySchema,
});

// A shape GitHub will send the same way every time is no reason to retry.
function read<T>(schema: z.ZodType<T>, payload: unknown, what: string): T | null {
  const parsed = schema.safeParse(payload);
  if (!parsed.success)
    console.error(`[github] ignored ${what} it could not read: ${parsed.error.message}`);
  return parsed.data ?? null;
}

const matches = (values: readonly string[] | undefined, ...found: string[]) =>
  values === undefined || found.some((value) => values.includes(value));

// GitHub keeps an owner's casing wherever it is shown, so a name written by hand may differ.
const inRepositories = (repositories: readonly string[] | undefined, owner: string, repo: string) =>
  repositories === undefined ||
  repositories.some((name) => name.toLowerCase() === `${owner}/${repo}`.toLowerCase());

const describeNumbered = ({ owner, repo, number }: Record<string, unknown>) =>
  `github ${String(owner)}/${String(repo)}#${String(number)}`;

// No sender check: the factory's App merging a person's pull request is how
// commits usually reach a branch, and that push should start runs.
const GITHUB_PUSHES: Source<GitHubPushesParams> = {
  provider: "github",
  params: gitHubPushesParamsSchema,
  sampleInputs: {
    installationName: "acme",
    owner: "acme",
    repo: "api",
    branch: "main",
    before: "6113728f27ae82c7b1a177c8d03f9e96e0adf246",
    after: "0d1a26e67d8f5eaf1f6ba5c57fc3c7d91ac0fd1c",
  } satisfies GitHubPushInputs,
  async fromPush(params, { installationName, name, payload }) {
    if (installationName !== params.installationName || name !== "push") return null;
    const push = read(pushSchema, payload, "a push");
    if (push === null) return null;
    const { ref, before, after, deleted, repository } = push;
    if (!ref.startsWith(BRANCH_REF) || deleted) return null;
    const branch = ref.slice(BRANCH_REF.length);
    const owner = repository.owner.login;
    const repo = repository.name;
    if (!inRepositories(params.repositories, owner, repo)) return null;
    if (!matches(params.branches, branch)) return null;
    return {
      // `before` keeps a force-push back to a commit the branch held earlier a push of its own.
      key: `${owner}/${repo}:${branch}:${before}:${after}`,
      inputs: { installationName, owner, repo, branch, before, after } satisfies GitHubPushInputs,
      at: new Date(repository.pushed_at * 1000),
    };
  },
  describe: ({ owner, repo, branch, after }) =>
    `github ${String(owner)}/${String(repo)} ${String(branch)} ${String(after).slice(0, 7)}`,
};

const GITHUB_PULL_REQUESTS: Source<GitHubPullRequestsParams> = {
  provider: "github",
  params: gitHubPullRequestsParamsSchema,
  sampleInputs: {
    installationName: "acme",
    owner: "acme",
    repo: "api",
    number: 1,
  } satisfies PullRequestRef,
  async fromPush(params, { installationName, name, payload }) {
    if (installationName !== params.installationName || name !== "pull_request") return null;
    const event = read(pullRequestEventSchema, payload, "a pull_request event");
    if (event === null) return null;
    const { pull_request: pr, repository, sender } = event;
    const owner = repository.owner.login;
    const repo = repository.name;
    if (pr.state !== "open" || pr.draft) return null;
    if (
      !inRepositories(params.repositories, owner, repo) ||
      !matches(params.authors, pr.user.login) ||
      !matches(params.labels, ...pr.labels.map((label) => label.name)) ||
      !matches(params.baseBranches, pr.base.ref)
    )
      return null;
    if (sender.id === (await githubAuthFor(installationName).bot()).id) return null;
    return {
      key: `${owner}/${repo}#${pr.number}`,
      inputs: { installationName, owner, repo, number: pr.number } satisfies PullRequestRef,
      at: new Date(pr.updated_at),
    };
  },
  describe: describeNumbered,
};

const GITHUB_ISSUES: Source<GitHubIssuesParams> = {
  provider: "github",
  params: gitHubIssuesParamsSchema,
  sampleInputs: {
    installationName: "acme",
    owner: "acme",
    repo: "api",
    number: 1,
  } satisfies GitHubIssueInputs,
  async fromPush(params, { installationName, name, payload }) {
    if (installationName !== params.installationName || name !== "issues") return null;
    const event = read(issueEventSchema, payload, "an issues event");
    if (event === null) return null;
    const { issue, repository, sender } = event;
    const owner = repository.owner.login;
    const repo = repository.name;
    if (issue.state !== "open") return null;
    if (
      !inRepositories(params.repositories, owner, repo) ||
      !matches(params.authors, issue.user.login) ||
      !matches(params.labels, ...issue.labels.map((label) => label.name))
    )
      return null;
    if (sender.id === (await githubAuthFor(installationName).bot()).id) return null;
    return {
      key: `${owner}/${repo}#${issue.number}`,
      inputs: { installationName, owner, repo, number: issue.number } satisfies GitHubIssueInputs,
      at: new Date(issue.updated_at),
    };
  },
  describe: describeNumbered,
};

// No sender check, as for pushes: who published a release does not change that it shipped.
const GITHUB_RELEASES: Source<GitHubReleasesParams> = {
  provider: "github",
  params: gitHubReleasesParamsSchema,
  sampleInputs: {
    installationName: "acme",
    owner: "acme",
    repo: "api",
    tag: "v1.2.0",
  } satisfies GitHubReleaseInputs,
  async fromPush(params, { installationName, name, payload }) {
    if (installationName !== params.installationName || name !== "release") return null;
    const event = read(releaseEventSchema, payload, "a release event");
    if (event === null) return null;
    const { action, release, repository } = event;
    const owner = repository.owner.login;
    const repo = repository.name;
    const tag = release.tag_name;
    if (action !== "published" || release.draft || release.prerelease) return null;
    if (!inRepositories(params.repositories, owner, repo)) return null;
    return {
      key: `${owner}/${repo}@${tag}`,
      inputs: { installationName, owner, repo, tag } satisfies GitHubReleaseInputs,
      at: new Date(release.published_at),
    };
  },
  describe: ({ owner, repo, tag }) => `github ${String(owner)}/${String(repo)} ${String(tag)}`,
};

export const GITHUB_SOURCES = {
  [GITHUB_PUSHES_SOURCE]: GITHUB_PUSHES,
  [GITHUB_PULL_REQUESTS_SOURCE]: GITHUB_PULL_REQUESTS,
  [GITHUB_ISSUES_SOURCE]: GITHUB_ISSUES,
  [GITHUB_RELEASES_SOURCE]: GITHUB_RELEASES,
};
