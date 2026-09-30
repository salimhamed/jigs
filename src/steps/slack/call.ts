import { type SlackParams, type SlackReply, slackCall } from "../../providers/slack.ts";

/**
 * Call any Slack Web API method as the factory's bot, and return Slack's
 * response body. Wrap it in your own `"use step"` function.
 *
 * @remarks
 * Arguments that are not strings, such as `blocks`, are sent JSON-encoded, and
 * `undefined` ones are left out. When Slack answers `ok: false`, it throws a
 * {@link SlackApiError} with Slack's error as its `code`. Rate-limited calls are
 * retried.
 *
 * A step can run more than once, so a call that is not safe to repeat has to
 * accept what a repeat gets back, such as `already_reacted` from
 * `reactions.add`. Add any scope the method needs that jigs does not already
 * use to `slack.scopes` in `jigs.config.ts`.
 *
 * @example
 * ```ts
 * // workflows/deploys/steps.ts
 * import { callSlack, SlackApiError } from "@jigs-ai/jigs/steps/slack";
 *
 * export async function react(channel: string, timestamp: string, name: string) {
 *   "use step";
 *   try {
 *     await callSlack("reactions.add", { channel, timestamp, name });
 *   } catch (error) {
 *     if (!(error instanceof SlackApiError && error.code === "already_reacted")) throw error;
 *   }
 * }
 * ```
 *
 * @group Create and update
 */
export async function callSlack<T = Record<string, unknown>>(
  method: string,
  params: SlackParams = {},
): Promise<T> {
  const { body } = await slackCall<SlackReply & T>(method, params);
  console.log(`[slack] called ${method}`);
  return body;
}
