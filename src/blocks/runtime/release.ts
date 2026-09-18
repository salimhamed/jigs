import { z } from "zod";

export const releaseSchema = z.strictObject({
  onSuccess: z.enum(["release", "keep"]),
  onFailure: z.enum(["keep", "release"]),
});
export type ReleasePolicy = z.input<typeof releaseSchema>;
export const defaultReleasePolicy = (): ReleasePolicy => ({
  onSuccess: "release",
  onFailure: "keep",
});

export interface ReleasedResource {
  path: string;
  removed: boolean;
  reason: string;
}
export interface ReleaseReport {
  policy: ReleasePolicy;
  worktrees: (ReleasedResource & {
    branch: string;
    localBranchDeleted: boolean;
    remoteBranchDeleted: boolean;
    unmergedCommits: number | null;
  })[];
  runDirectory: ReleasedResource;
}

export interface ReleaseSteps {
  resolveReleasePolicy: () => Promise<ReleasePolicy>;
  releaseRunResources: (policy: ReleasePolicy) => Promise<ReleaseReport>;
}

/** Release as the last successful action. Never call in finally or catch: waits throw too. */
export async function release(steps: ReleaseSteps, policy?: ReleasePolicy): Promise<ReleaseReport> {
  return steps.releaseRunResources(policy ?? (await steps.resolveReleasePolicy()));
}

export function bindReleaseSteps(steps: ReleaseSteps) {
  return { release: (policy?: ReleasePolicy) => release(steps, policy) };
}
