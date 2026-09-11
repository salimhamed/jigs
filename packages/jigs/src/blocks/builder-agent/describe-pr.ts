// Naming a pull request and writing its body. The mechanics live here — resume
// the builder that wrote the change, fall back to a fresh context fed the
// diff, parse a `{ title, body }` back — and the prose does not: the caller
// passes both prompts, and whether a drifting title is repaired or refused is
// the factory's policy, applied to what comes back.
//
// The fresh prompt is a function of the diff so the read that feeds it costs
// nothing when the resume is taken.

import { z } from "zod";
import type { readDiff } from "../../steps/pull-request/branch.ts";
import type { HarnessConfig } from "../agent/harness-config.ts";
import type { Prompt } from "../agent/plan.ts";
import type { AgentSession } from "../agent/result.ts";
import { type AgentFn, resumeOrRebuild } from "../agent/resume-or-rebuild.ts";

export const prDescription = z.strictObject({
  title: z.string().min(1),
  body: z.string().min(1),
});

export type PrDescription = z.output<typeof prDescription>;

export interface DescribePrOptions {
  agent: AgentFn;
  readDiff: typeof readDiff;
  harness: HarnessConfig;
  cwd: string;
  baseSha: string;
  session?: AgentSession;
  resumePrompt: Prompt;
  freshPrompt: (diff: string) => Prompt;
}

export async function describePr(
  options: DescribePrOptions,
): Promise<PrDescription> {
  const { agent, readDiff: read } = options;

  const described = await resumeOrRebuild({
    agent,
    label: "describePr",
    harness: options.harness,
    cwd: options.cwd,
    ...(options.session === undefined ? {} : { session: options.session }),
    resumePrompt: options.resumePrompt,
    freshPrompt: async () =>
      options.freshPrompt(await read(options.cwd, options.baseSha)),
    output: prDescription,
  });
  return described.output;
}
