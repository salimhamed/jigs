// Fixing red CI as the builder: the same resume-first shape the review answers
// use, with the same first-class fresh-context rebuild. A fix agent that never
// saw the ticket, the brief or the diff is guessing at the change it is
// repairing.

import type { CheckRun } from "../../providers/github.ts";
import type { readDiff } from "../../steps/pull-request/branch.ts";
import type { HarnessConfig } from "../agent/harness-config.ts";
import type { AgentSession } from "../agent/result.ts";
import { type AgentFn, resumeOrRebuild } from "../agent/resume-or-rebuild.ts";
import { interpolate } from "../interpolate.ts";
import { renderChecks } from "../pull-request/answers.ts";
import type { Handoff } from "../ticket/review.ts";
import { renderSnapshot } from "../ticket/snapshot.ts";
import { fixCiPrompt } from "./fix-ci.prompt.ts";
import { fixCiFreshPrompt } from "./fix-ci-fresh.prompt.ts";

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
    resumePrompt: interpolate(fixCiPrompt, {
      CHECKS: checks,
      ATTEMPT: options.attempt,
    }),
    freshPrompt: async () => {
      const diff = await read(options.cwd, options.baseSha);
      return interpolate(fixCiFreshPrompt, {
        TICKET: renderSnapshot(options.handoff.snapshot),
        BRIEF: options.handoff.brief,
        DIFF: diff,
        CHECKS: checks,
        ATTEMPT: options.attempt,
      });
    },
  });
}
