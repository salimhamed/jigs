import { fn } from "@jigs/service/steps";
import { worktree } from "@jigs/service/worktrees";
import { z } from "zod";

export const fixtureInputs = z.object({
  provision: z.boolean().default(false),
});

type FixtureInputs = z.output<typeof fixtureInputs> & { triggerId: string };

// One pipeline, three compile paths — a factory-local "use workflow" body, a
// factory-local "use step" beside it, and steps reached through
// @jigs/service in node_modules. Nothing here ever runs; what CI reads is the
// ids the build emits for all three.
export async function fixturePipeline(inputs: FixtureInputs) {
  "use workflow";

  const local = await fn(localStep, inputs.triggerId);
  // Never taken. The imported step has to be called, not merely imported, or
  // the bundler is free to drop the module that registers it.
  if (inputs.provision) {
    await worktree({ binding: "none", branch: "fixture" });
  }
  return local.output;
}

async function localStep(triggerId: string) {
  "use step";
  return { triggerId };
}
