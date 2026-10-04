import { z } from "zod";
import type { ResourceRecord } from "./resources.ts";

const releaseAction = z.enum(["release", "keep"]);

/**
 * What release does with a finished run's resources.
 *
 * @group Runtime and resources
 */
export type ReleaseAction = z.infer<typeof releaseAction>;

/** Whether a run completed (`success`), or failed or was cancelled (`failure`). */
export type RunOutcome = "success" | "failure";

export const releaseSchema = z.strictObject({
  /** What to do with eligible resources after a completed run. */
  onSuccess: releaseAction,
  /** What to do with eligible resources after a failed or cancelled run. */
  onFailure: releaseAction,
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
