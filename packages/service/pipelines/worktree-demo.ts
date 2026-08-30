import { createHook } from "workflow";
import { z } from "zod";
import { worktree } from "../src/worktrees";

export const worktreeDemoInputs = z.object({
  binding: z.string().default("scratch"),
  branch: z.string(),
  keep: z.boolean().default(false),
});

type WorktreeDemoInputs = z.output<typeof worktreeDemoInputs> & {
  triggerId: string;
};

// Worktree-lifecycle acceptance vehicle: request a worktree, suspend on a
// hook (a suspended run keeps its worktree), resume, complete — and the
// automatic teardown pass does the cleanup nobody wrote.
export async function worktreeDemoPipeline(inputs: WorktreeDemoInputs) {
  "use workflow";

  const facts = await worktree({
    binding: inputs.binding,
    branch: inputs.branch,
    keep: inputs.keep,
  });
  console.log(`[worktree-demo] provisioned ${facts.path} on ${facts.branch}`);

  // Keep in sync with the factory entry's hookToken.
  using hook = createHook<{ note?: string }>({
    token: `worktree:${inputs.triggerId}`,
  });
  await hook;

  console.log(`[worktree-demo] resumed, still holding ${facts.path}`);
  return {
    path: facts.path,
    branch: facts.branch,
    resolution: facts.resolution,
  };
}
