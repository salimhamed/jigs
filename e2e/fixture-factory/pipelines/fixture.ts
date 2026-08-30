import { fn } from "@jigs/service/steps";
import { claimTicket } from "@jigs/service/suspension/claim";
import { claude } from "jigs/steps";
import { z } from "zod";
import {
  fetchSnapshot,
  reviewLoop,
  ticketReview,
  worktree,
} from "../steps/jigs.ts";

export const fixtureInputs = z.object({
  provision: z.boolean().default(false),
});

type FixtureInputs = z.output<typeof fixtureInputs> & { triggerId: string };

// One pipeline, three compile paths — a factory-local "use workflow" body, a
// factory-local "use step" beside it, and this factory's scaffolded steps/
// wrappers with the shipped jigs wired on top of them. Nothing here ever runs;
// what CI reads is the ids the build emits for all three.
export async function fixturePipeline(inputs: FixtureInputs) {
  "use workflow";

  const local = await fn(localStep, inputs.triggerId);
  // Never taken. The wrappers have to be called, not merely imported, or the
  // bundler is free to drop the module that registers them — and the jigs
  // have to reach the workflow bundle for the build to prove they drag no
  // node builtins in behind their step-side imports.
  if (inputs.provision) {
    const claim = await claimTicket(inputs.triggerId);
    const snapshot = await fetchSnapshot(inputs.triggerId);
    const harness = claude({ model: "fixture" });
    const tree = await worktree({ binding: "none", branch: "fixture" });
    const handoff = await ticketReview({
      claim,
      snapshot,
      harness,
      cwd: tree.path,
    });
    await reviewLoop({
      claim,
      handoff,
      harness,
      worktree: tree,
      binding: "none",
    });
  }
  return local.output;
}

async function localStep(triggerId: string) {
  "use step";
  return { triggerId };
}
