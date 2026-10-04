import { expect, test } from "vitest";
import { slackHistory, slackPostMessage } from "../providers/slack.ts";
import { SOURCES } from "./event-triggers/sources.ts";
import { type SlackMessageEvent, startSlackSocket } from "./slack-socket.ts";

// Posts one short message to the test channel and sees it arrive over Socket
// Mode and in history. It is the bot's own post, so both sources skip it.
// Set SLACK_BOT_TOKEN and SLACK_APP_TOKEN to a test app's that is in the
// channel. One connection only: apps.connections.open allows about one a minute.
const configured = Boolean(process.env.SLACK_BOT_TOKEN && process.env.SLACK_APP_TOKEN);
const channel = "C0C5EUZ7P9Q";
const params = { channels: [channel] };

const until = async (condition: () => boolean, ms: number) => {
  const deadline = Date.now() + ms;
  while (!condition() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  return condition();
};

// A message posted before the connection is up arrives only as Slack's late
// redelivery, so another is posted until one comes through.
test.skipIf(!configured)("a posted message arrives over Socket Mode and in history", async () => {
  const messages = SOURCES["slack.messages"];
  if (messages === undefined) throw new Error("no slack.messages source");
  const seen: SlackMessageEvent[] = [];
  const socket = startSlackSocket({
    onMessage: (event) => {
      seen.push(event);
    },
  });
  try {
    const since = new Date(Date.now() - 5_000);
    let event: SlackMessageEvent | undefined;
    for (let attempt = 1; attempt <= 3 && event === undefined; attempt += 1) {
      const ts = await slackPostMessage({
        channel,
        text: `jigs live test: Socket Mode and history (${attempt})`,
      });
      await until(() => seen.some((pushed) => pushed.ts === ts), 10_000);
      event = seen.find((pushed) => pushed.ts === ts);
    }
    if (event === undefined) throw new Error("no posted message arrived over Socket Mode");
    expect(event).toMatchObject({ type: "message", channel, channel_type: "channel" });
    expect(await messages.fromPush(params, event)).toBeNull();

    const history = await slackHistory(channel, { oldest: (since.getTime() / 1000).toFixed(6) });
    expect(history.map((message) => message.ts)).toContain(event.ts);
    const polled = await messages.poll(params, undefined, since);
    expect(polled.occurrences.map((occurrence) => occurrence.inputs.ts)).not.toContain(event.ts);
  } finally {
    socket.stop();
  }
});
