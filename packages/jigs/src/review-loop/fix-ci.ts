// Fixing red CI as the builder (ADR 0009): the same resume-first shape the
// review answers use, with the same first-class fresh-context rebuild. A fix
// agent that never saw the ticket, the brief or the diff is guessing at the
// change it is repairing.

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
  harness: HarnessConfig;
  cwd: string;
  session?: AgentSession;
  failing: CheckRun[];
  attempt: string;
  handoff: Handoff;
  baseSha: string;
}

export type FixCiDeps = {
  agent: AgentFn;
  readDiff: typeof readDiff;
};

export function renderChecks(failing: CheckRun[]): string {
  return failing.length === 0
    ? "_(the provider reported a red build without naming a check)_"
    : failing
        .map(
          (check) => `- **${check.name}** — ${check.conclusion} — ${check.url}`,
        )
        .join("\n");
}

export async function fixCi(
  options: FixCiOptions,
  deps: FixCiDeps,
): Promise<{ session?: AgentSession }> {
  const checks = renderChecks(options.failing);

  return resumeOrRebuild({
    agent: deps.agent,
    label: "reviewLoop",
    harness: options.harness,
    cwd: options.cwd,
    ...(options.session === undefined ? {} : { session: options.session }),
    resumePrompt: interpolate(fixCiPrompt, {
      CHECKS: checks,
      ATTEMPT: options.attempt,
    }),
    freshPrompt: async () => {
      // Destructured, never invoked as `deps.readDiff(...)`: the SDK
      // serializes a step call's receiver along with its arguments, and this
      // object holds functions.
      const { readDiff: read } = deps;
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
