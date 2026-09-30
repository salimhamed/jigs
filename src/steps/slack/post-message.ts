import { slackPostMessage } from "../../providers/slack.ts";

/**
 * Post plain `mrkdwn` text to a channel, or as a reply in the thread under
 * `threadTs`. Returns the new message's ts.
 *
 * @group Create and update
 */
export async function postSlackMessage(message: {
  channel: string;
  text: string;
  threadTs?: string | undefined;
}): Promise<string> {
  const ts = await slackPostMessage(message);
  console.log(
    `[slack] posted ${message.channel} ${ts}${message.threadTs === undefined ? "" : ` in thread ${message.threadTs}`}`,
  );
  return ts;
}
