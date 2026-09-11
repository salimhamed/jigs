// Saving work the builder finished but never committed: the same resume-first
// shape the CI fix and the review answers use, with the same prompt on both
// arms — the work is on disk in the cwd, so a fresh builder reading the
// worktree has everything the resumed one would have had.

import type { HarnessConfig } from "../agent/harness-config.ts";
import type { AgentSession } from "../agent/result.ts";
import { type AgentFn, resumeOrRebuild } from "../agent/resume-or-rebuild.ts";
import {
  type CommitWorkPrompt,
  commitWorkPrompt,
} from "./commit-work.prompt.ts";

export interface CommitWorkOptions {
  agent: AgentFn;
  harness: HarnessConfig;
  cwd: string;
  session?: AgentSession;
  // The words, which the factory owns: its own function in place of the one
  // shipped beside this block. One prompt, both arms.
  prompt?: CommitWorkPrompt;
}

export async function commitWork(
  options: CommitWorkOptions,
): Promise<AgentSession | undefined> {
  const { agent } = options;
  const prompt = (options.prompt ?? commitWorkPrompt)({});
  const committed = await resumeOrRebuild({
    agent,
    label: "commitWork",
    harness: options.harness,
    cwd: options.cwd,
    ...(options.session === undefined ? {} : { session: options.session }),
    resumePrompt: prompt,
    freshPrompt: prompt,
  });
  return committed.session;
}
