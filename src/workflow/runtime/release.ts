import { z } from "zod";
import type { ResourceRecord } from "./resources.ts";

export const releaseSchema = z.strictObject({
  /** What to do with eligible resources after a completed run. */
  onSuccess: z.enum(["release", "keep"]),
  /** What to do with eligible resources after a failed or cancelled run. */
  onFailure: z.enum(["keep", "release"]),
});
/**
 * Selects whether eligible run resources are released for each terminal outcome.
 *
 * @group Runtime and resources
 */
export type ReleasePolicy = z.input<typeof releaseSchema>;
export const defaultReleasePolicy = (): ReleasePolicy => ({
  onSuccess: "release",
  onFailure: "keep",
});

/**
 * The result of applying a release policy to one run's resources.
 *
 * @group Runtime and resources
 */
export interface ReleaseReport {
  /** The policy applied by this release attempt. */
  policy: ReleasePolicy;
  /** Every resource the run recorded, with its state and reason after this attempt. */
  resources: ResourceRecord[];
}
