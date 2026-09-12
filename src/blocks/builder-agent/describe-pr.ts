// Naming a pull request and writing its body. The mechanics live here — resume
// the builder that wrote the change, fall back to a fresh context fed the
// diff, parse a `{ title, body }` back — and the prose does not: the caller
// passes both prompts, and whether a drifting title is repaired or refused is
// the factory's policy, applied to what comes back.
//
// The fresh prompt is a function of the diff so the read that feeds it costs
// nothing when the resume is taken.

import { z } from "zod";
import type { readWorktreeDiff } from "../../steps/pull-request/branch.ts";
import type { HarnessConfig } from "../agent/harness-config.ts";
import type { AgentSession } from "../agent/result.ts";
import { type AgentFn, resumeOrRebuild } from "../agent/resume-or-rebuild.ts";

export const pullRequestDescription = z.strictObject({
  title: z.string().min(1),
  body: z.string().min(1),
});

export type PullRequestDescription = z.output<typeof pullRequestDescription>;

export interface DescribePullRequestOptions {
  agent: AgentFn;
  readWorktreeDiff: typeof readWorktreeDiff;
  harness: HarnessConfig;
  cwd: string;
  baseSha: string;
  session?: AgentSession;
  resumePrompt: string;
  freshPrompt: (diff: string) => string;
}

/** Ask the builder to write a pull request title and description for its changes. */
export async function describePullRequest(
  options: DescribePullRequestOptions,
): Promise<PullRequestDescription> {
  const { agent, readWorktreeDiff: read } = options;

  const described = await resumeOrRebuild({
    agent,
    label: "describePullRequest",
    harness: options.harness,
    cwd: options.cwd,
    ...(options.session === undefined ? {} : { session: options.session }),
    resumePrompt: options.resumePrompt,
    freshPrompt: async () => options.freshPrompt(await read(options.cwd, options.baseSha)),
    output: pullRequestDescription,
  });
  return described.output;
}
