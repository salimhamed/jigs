// The GitHub sources, read off the webhooks the hub passes on under GitHub's
// event name. A push to a branch is one occurrence, keyed by the branch and
// the commit it moved to.

import { z } from "zod";
import {
  GITHUB_PUSHES_SOURCE,
  type GitHubPushesParams,
  type GitHubPushInputs,
  gitHubPushesParamsSchema,
} from "../workflow/github/source.ts";
import type { Source } from "./event-triggers/sources.ts";

const BRANCH_REF = "refs/heads/";

// Only what the occurrence and the filters read; GitHub sends more.
const pushSchema = z.object({
  ref: z.string(),
  before: z.string(),
  after: z.string(),
  deleted: z.boolean(),
  repository: z.object({
    name: z.string().min(1),
    owner: z.object({ login: z.string().min(1) }),
    // Epoch seconds in a push event, unlike the ISO times other events carry.
    pushed_at: z.number(),
  }),
});

const SAMPLE_PUSH = {
  installationName: "acme",
  owner: "acme",
  repo: "api",
  ref: "main",
  before: "6113728f27ae82c7b1a177c8d03f9e96e0adf246",
  after: "0d1a26e67d8f5eaf1f6ba5c57fc3c7d91ac0fd1c",
} satisfies GitHubPushInputs;

// GitHub keeps an owner's casing wherever it is shown, so a name written by hand may differ.
const inRepositories = (repositories: readonly string[] | undefined, owner: string, repo: string) =>
  repositories === undefined ||
  repositories.some((name) => name.toLowerCase() === `${owner}/${repo}`.toLowerCase());

// No sender check: the factory's App merging a person's pull request is how
// commits usually reach a branch, and that push should start runs.
const GITHUB_PUSHES: Source<GitHubPushesParams> = {
  provider: "github",
  params: gitHubPushesParamsSchema,
  sampleInputs: SAMPLE_PUSH,
  async fromPush(params, { installationName, name, payload }) {
    if (installationName !== params.installationName || name !== "push") return null;
    // A shape GitHub will send the same way every time is no reason to retry.
    const push = pushSchema.safeParse(payload);
    if (!push.success) {
      console.error(`[github] ignored a push it could not read: ${push.error.message}`);
      return null;
    }
    const { ref, before, after, deleted, repository } = push.data;
    if (!ref.startsWith(BRANCH_REF) || deleted) return null;
    const branch = ref.slice(BRANCH_REF.length);
    const owner = repository.owner.login;
    const repo = repository.name;
    if (!inRepositories(params.repositories, owner, repo)) return null;
    if (params.branches && !params.branches.includes(branch)) return null;
    const inputs = {
      installationName,
      owner,
      repo,
      ref: branch,
      before,
      after,
    } satisfies GitHubPushInputs;
    return {
      key: `${owner}/${repo}:${branch}:${after}`,
      inputs,
      at: new Date(repository.pushed_at * 1000),
    };
  },
  describe: ({ owner, repo, ref, after }) =>
    `github ${String(owner)}/${String(repo)} ${String(ref)} ${String(after).slice(0, 7)}`,
};

export const GITHUB_SOURCES = {
  [GITHUB_PUSHES_SOURCE]: GITHUB_PUSHES,
};
