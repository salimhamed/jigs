// Fixing red CI as the builder (ADR 0009): the same resume-first shape the
// review answers use, with the same first-class fresh-context rebuild. A fix
// agent that never saw the ticket, the brief or the diff is guessing at the
// change it is repairing.

import {
  fixCiFreshPrompt,
  fixCiPrompt,
  interpolate,
} from "@salimhamed/jigs/prompts";
import type { AgentSession, HarnessConfig } from "@salimhamed/jigs/steps";
import type { CheckRun } from "../providers/github";
import { type AgentFn, ResumeFailedError } from "../steps";
import type { Handoff } from "../ticket/review";
import { renderSnapshot } from "../ticket/snapshot";
import type { readDiff } from "./pull-request";

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

export type FixCiResult = {
  // Set only when the resume failed and a fresh context did the fix: that
  // session, and not the stale one, is the one now holding the change.
  session?: AgentSession;
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
): Promise<FixCiResult> {
  const checks = renderChecks(options.failing);

  if (options.session !== undefined) {
    try {
      await deps.agent({
        harness: options.harness,
        cwd: options.cwd,
        permissionMode: "bypassPermissions",
        resume: options.session,
        prompt: interpolate(fixCiPrompt, {
          CHECKS: checks,
          ATTEMPT: options.attempt,
        }),
      });
      return {};
    } catch (err) {
      if (!(err instanceof ResumeFailedError)) throw err;
      console.log("[reviewLoop] resume failed — rebuilding context");
    }
  }

  // Destructured, never invoked as `deps.readDiff(...)`: the SDK serializes a
  // step call's receiver along with its arguments, and this object holds
  // functions.
  const { readDiff: read } = deps;
  const diff = await read(options.cwd, options.baseSha);
  const fixed = await deps.agent({
    harness: options.harness,
    cwd: options.cwd,
    permissionMode: "bypassPermissions",
    prompt: interpolate(fixCiFreshPrompt, {
      TICKET: renderSnapshot(options.handoff.snapshot),
      BRIEF: options.handoff.brief,
      DIFF: diff,
      CHECKS: checks,
      ATTEMPT: options.attempt,
    }),
  });
  return { ...(fixed.session === undefined ? {} : { session: fixed.session }) };
}
