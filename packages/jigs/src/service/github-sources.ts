// The GitHub sources, read off the webhooks the hub passes on under GitHub's
// event name. A push to a branch is one occurrence, keyed by the branch and
// the commits it moved from and to; a pull request is one, keyed by its number.

import { z } from "zod";
import { githubAuthFor } from "../providers/github-auth.ts";
import {
  GITHUB_PULL_REQUESTS_SOURCE,
  GITHUB_PUSHES_SOURCE,
  type GitHubPullRequestsParams,
  type GitHubPushesParams,
  type GitHubPushInputs,
  gitHubPullRequestsParamsSchema,
  gitHubPushesParamsSchema,
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

const pullRequestEventSchema = z.object({
  pull_request: z.object({
    number: z.number(),
    state: z.string(),
    draft: z.boolean(),
    updated_at: z.iso.datetime({ offset: true }),
    user: z.object({ login: z.string() }),
    labels: z.array(z.object({ name: z.string() })),
    base: z.object({ ref: z.string() }),
  }),
  repository: repositorySchema,
  sender: z.object({ id: z.number() }),
});

// A shape GitHub will send the same way every time is no reason to retry.
function read<T>(schema: z.ZodType<T>, payload: unknown, event: string): T | null {
  const parsed = schema.safeParse(payload);
  if (!parsed.success)
    console.error(`[github] ignored a ${event} it could not read: ${parsed.error.message}`);
  return parsed.data ?? null;
}

const matches = (values: readonly string[] | undefined, ...found: string[]) =>
  values === undefined || found.some((value) => values.includes(value));

// GitHub keeps an owner's casing wherever it is shown, so a name written by hand may differ.
const inRepositories = (repositories: readonly string[] | undefined, owner: string, repo: string) =>
  repositories === undefined ||
  repositories.some((name) => name.toLowerCase() === `${owner}/${repo}`.toLowerCase());

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
    const push = read(pushSchema, payload, "push");
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
    const event = read(pullRequestEventSchema, payload, "pull_request event");
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
  describe: ({ owner, repo, number }) =>
    `github ${String(owner)}/${String(repo)}#${String(number)}`,
};

export const GITHUB_SOURCES = {
  [GITHUB_PUSHES_SOURCE]: GITHUB_PUSHES,
  [GITHUB_PULL_REQUESTS_SOURCE]: GITHUB_PULL_REQUESTS,
};
