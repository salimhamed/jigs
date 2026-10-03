import { JigsError } from "../errors.ts";
import { formats, pullRequestDescription, withFormat } from "./answers.ts";
import type { Delivery, DeliveryPrompts, DeliverySteps } from "./delivery.ts";

/**
 * The parts of a delivery `describePullRequest` reads.
 *
 * @group Pull request delivery
 */
export type DescribeDelivery<W> = Pick<Delivery<W>, "work" | "worktree" | "builder" | "writer"> & {
  prompts: Pick<DeliveryPrompts<W>, "describe">;
};

/**
 * A pull request title and body.
 *
 * @group Pull request delivery
 */
export interface Described {
  title: string;
  body: string;
}

/**
 * What `describePullRequest` needs besides the delivery.
 *
 * @group Pull request delivery
 */
export interface DescribeOptions {
  /**
   * The problems with a title and body, such as a title that breaks your naming convention; none
   * means they are fine. The writer is sent back once with the problems, and problems in its
   * second answer throw.
   */
  check?: ((described: Described) => string[]) | undefined;
}

/**
 * Have the writer, or the builder when there is none, write the pull request's title and body
 * from the diff.
 *
 * @remarks
 * A title that is not one plain line, or a body with a "Title:" or "Description:" label line, is
 * sent back once with the reasons; a second bad answer throws. `check` adds your own rules the
 * same way. Nothing is pushed.
 *
 * @group Pull request delivery
 */
export async function describePullRequest<W>(
  delivery: DescribeDelivery<W>,
  { check }: DescribeOptions,
  steps: Pick<DeliverySteps, "readWorktreeDiff">,
): Promise<Described> {
  const { work, worktree, prompts } = delivery;
  const writer = delivery.writer ?? delivery.builder;
  const asked = prompts.describe({ work, worktree, diff: await steps.readWorktreeDiff(worktree) });
  // The prompt carries every fact it needs, so a resumed and a fresh writer are told the same.
  const prompt = withFormat(asked, formats.describe);
  const described = await writer.run({
    output: pullRequestDescription,
    resume: prompt,
    fresh: prompt,
  });
  const problems = check?.(described) ?? [];
  if (problems.length === 0) return described;

  const fix = `A first title and body had these problems:\n${list(problems)}\n\nWrite the title and body again without them.`;
  const again = await writer.run({
    output: pullRequestDescription,
    resume: withFormat(fix, formats.describe),
    fresh: withFormat(`${asked}\n\n${fix}`, formats.describe),
  });
  const remaining = check?.(again) ?? [];
  if (remaining.length > 0) {
    throw new JigsError(
      `the pull request title and body still have problems after one retry: ${remaining.join("; ")}`,
    );
  }
  return again;
}

const list = (items: string[]) => items.map((item) => `- ${item}`).join("\n");
