// Saving work the builder finished but never committed: the same resume-first
// shape the CI fix and the review answers use, with the same prompt on both
// arms — the work is on disk in the cwd, so a fresh builder reading the
// worktree has everything the resumed one would have had.

import type { HarnessConfig } from "../agent/harness-config.ts";
import type { AgentSession } from "../agent/result.ts";
import { type AgentFn, resumeOrRebuild } from "../agent/resume-or-rebuild.ts";

const COMMIT_WORK = "commit-work";

export interface CommitWorkOptions {
  agent: AgentFn;
  harness: HarnessConfig;
  cwd: string;
  session?: AgentSession;
  // Names a registered prompt; defaults to the one jigs ships.
  prompt?: string;
}

export async function commitWork(
  options: CommitWorkOptions,
): Promise<AgentSession | undefined> {
  const { agent } = options;
  // The same prompt on both arms: the work is on disk in the cwd, so a fresh
  // builder reading the worktree has everything the resumed one would.
  const prompt = { name: options.prompt ?? COMMIT_WORK, data: {} };
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
