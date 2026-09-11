// Fixing red CI as the builder: the same resume-first shape the review answers
// use, with the same first-class fresh-context rebuild. A fix agent that never
// saw the ticket, the brief or the diff is guessing at the change it is
// repairing.

import {
  fixCiFreshPrompt,
  fixCiPrompt,
  interpolate,
} from "../prompts/index.ts";
import type { CheckRun } from "../providers/github.ts";
import type { AgentSession, HarnessConfig } from "../steps/index.ts";
import { type AgentFn, resumeOrRebuild } from "../steps/index.ts";
import type { Handoff } from "../ticket/review.ts";
import { renderSnapshot } from "../ticket/snapshot.ts";
import type { readDiff } from "./pull-request.ts";

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

export function renderChecks(failing: CheckRun[]): string {
  return failing.length === 0
    ? "_(the provider reported a red build without naming a check)_"
    : failing
        .map((check) => {
          // A commit status may carry no target_url at all, and a line
          // trailing off into an empty link reads as a broken one.
          const named = `- **${check.name}** — ${check.conclusion}`;
          return check.url === "" ? named : `${named} — ${check.url}`;
        })
        .join("\n");
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
