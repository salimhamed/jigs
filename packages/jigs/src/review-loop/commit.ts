// Saving work the builder finished but never committed: the same resume-first
// shape the CI fix and the review answers use, with the same prompt on both
// arms — the work is on disk in the cwd, so a fresh builder reading the
// worktree has everything the resumed one would have had.

import { commitWorkPrompt } from "../prompts/index.ts";
import type { AgentSession, HarnessConfig } from "../steps/index.ts";
import { type AgentFn, resumeOrRebuild } from "../steps/index.ts";

export interface CommitLeftoverWorkOptions {
  agent: AgentFn;
  harness: HarnessConfig;
  cwd: string;
  session?: AgentSession;
}

export async function commitLeftoverWork(
  options: CommitLeftoverWorkOptions,
): Promise<AgentSession | undefined> {
  const { agent } = options;
  const committed = await resumeOrRebuild({
    agent,
    label: "commitLeftoverWork",
    harness: options.harness,
    cwd: options.cwd,
    ...(options.session === undefined ? {} : { session: options.session }),
    resumePrompt: commitWorkPrompt,
    freshPrompt: commitWorkPrompt,
  });
  return committed.session;
}
