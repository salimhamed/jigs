// Fixing red CI as the builder: the same resume-first shape the review answers
// use, with the same first-class fresh-context rebuild. A fix agent that never
// saw the ticket, the brief or the diff is guessing at the change it is
// repairing.

import type { CheckRun } from "../../providers/github.ts";
import type { readWorktreeDiff } from "../../steps/pull-request/branch.ts";
import type { HarnessConfig } from "../agent/harness-config.ts";
import type { AgentSession } from "../agent/result.ts";
import { type AgentFn, resumeOrRebuild } from "../agent/resume-or-rebuild.ts";
import { renderChecks } from "../pull-request/answers.ts";
import type { Handoff } from "../ticket/review.ts";
import { renderSnapshot } from "../ticket/snapshot.ts";
import { type FixCiPrompt, fixCiPrompt } from "./fix-ci.prompt.ts";
import { type FixCiFreshPrompt, fixCiFreshPrompt } from "./fix-ci-fresh.prompt.ts";

export interface FixCiOptions {
  agent: AgentFn;
  readWorktreeDiff: typeof readWorktreeDiff;
  harness: HarnessConfig;
  cwd: string;
  session?: AgentSession;
  failing: CheckRun[];
  attempt: string;
  handoff: Handoff;
  baseSha: string;
  // The words on each arm, which the factory owns: its own functions in place
  // of the ones shipped beside this block.
  resumePrompt?: FixCiPrompt;
  freshPrompt?: FixCiFreshPrompt;
}

/**
 * A resumed fix runs inside the builder's own session and leaves the pointer
 * where it is; only the fresh-context rebuild reports a session, and that one
 * is then the one holding the change.
 */
export async function fixCi(options: FixCiOptions): Promise<{ session?: AgentSession }> {
  const { agent, readWorktreeDiff: read } = options;
  const checks = renderChecks(options.failing);
  const renderResume = options.resumePrompt ?? fixCiPrompt;
  const renderFresh = options.freshPrompt ?? fixCiFreshPrompt;

  return resumeOrRebuild({
    agent,
    label: "fixCi",
    harness: options.harness,
    cwd: options.cwd,
    ...(options.session === undefined ? {} : { session: options.session }),
    resumePrompt: renderResume({ checks, attempt: options.attempt }),
    freshPrompt: async () => {
      const diff = await read(options.cwd, options.baseSha);
      return renderFresh({
        ticket: renderSnapshot(options.handoff.snapshot),
        brief: options.handoff.brief,
        diff,
        checks,
        attempt: options.attempt,
      });
    },
  });
}
