// Fixing red CI as the builder: the same resume-first shape the review answers
// use, with the same first-class fresh-context rebuild. A fix agent that never
// saw the ticket, the brief or the diff is guessing at the change it is
// repairing.

import type { CheckRun } from "../../providers/github.ts";
import type { readDiff } from "../../steps/pull-request/branch.ts";
import type { HarnessConfig } from "../agent/harness-config.ts";
import type { AgentSession } from "../agent/result.ts";
import { type AgentFn, resumeOrRebuild } from "../agent/resume-or-rebuild.ts";
import { renderChecks } from "../pull-request/answers.ts";
import type { Handoff } from "../ticket/review.ts";
import { renderSnapshot } from "../ticket/snapshot.ts";

const FIX_CI = "fix-ci";
const FIX_CI_FRESH = "fix-ci-fresh";

export interface FixCiOptions {
  agent: AgentFn;
  readDiff: typeof readDiff;
  harness: HarnessConfig;
  cwd: string;
  session?: AgentSession;
  failing: CheckRun[];
  attempt: string;
  handoff: Handoff;
  baseSha: string;
  // Each names a registered prompt; both default to the ones jigs ships.
  prompt?: string;
  freshPrompt?: string;
}

/**
 * A resumed fix runs inside the builder's own session and leaves the pointer
 * where it is; only the fresh-context rebuild reports a session, and that one
 * is then the one holding the change.
 */
export async function fixCi(
  options: FixCiOptions,
): Promise<{ session?: AgentSession }> {
  const { agent, readDiff: read } = options;
  const checks = renderChecks(options.failing);

  return resumeOrRebuild({
    agent,
    label: "fixCi",
    harness: options.harness,
    cwd: options.cwd,
    ...(options.session === undefined ? {} : { session: options.session }),
    resumePrompt: {
      name: options.prompt ?? FIX_CI,
      data: { CHECKS: checks, ATTEMPT: options.attempt },
    },
    freshPrompt: async () => {
      const diff = await read(options.cwd, options.baseSha);
      return {
        name: options.freshPrompt ?? FIX_CI_FRESH,
        data: {
          TICKET: renderSnapshot(options.handoff.snapshot),
          BRIEF: options.handoff.brief,
          DIFF: diff,
          CHECKS: checks,
          ATTEMPT: options.attempt,
        },
      };
    },
  });
}
