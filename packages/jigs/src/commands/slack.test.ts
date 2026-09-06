import { expect, test } from "vitest";
import { parse } from "yaml";
import { printSlackManifest, SLACK_APP_MANIFEST } from "./slack.ts";

const manifest = parse(SLACK_APP_MANIFEST) as {
  oauth_config: { scopes: { bot: string[] } };
  settings: {
    socket_mode_enabled: boolean;
    event_subscriptions: { bot_events: string[]; request_url?: string };
  };
};

test("the manifest is Socket Mode, and names no request URL", () => {
  // Slack rejects a manifest that carries both.
  expect(manifest.settings.socket_mode_enabled).toBe(true);
  expect(manifest.settings.event_subscriptions.request_url).toBeUndefined();
});

test("every event the connection subscribes to is subscribed to here", () => {
  // The `message.*` events arrive as one inner `message` event, so the four
  // channel kinds have to be listed separately or the socket goes quiet in
  // whichever kind was left out. `app_mention` is deliberately absent: Slack
  // delivers a channel mention as both, and the connection would ack and
  // answer one utterance twice.
  expect(manifest.settings.event_subscriptions.bot_events).toEqual([
    "message.channels",
    "message.groups",
    "message.im",
    "message.mpim",
  ]);
});

test("the scopes cover reading history, resolving channels, and posting", () => {
  const bot = manifest.oauth_config.scopes.bot;
  for (const kind of ["channels", "groups", "im", "mpim"]) {
    expect(bot).toContain(`${kind}:history`);
    expect(bot).toContain(`${kind}:read`);
  }
  expect(bot).toContain("chat:write");
  // The bot posts only where it is invited, so it needs no public override.
  expect(bot).not.toContain("chat:write.public");
  // Nothing subscribes to app_mention, so nothing needs the scope for it.
  expect(bot).not.toContain("app_mentions:read");
});

test("what is printed carries both token instructions after the manifest", () => {
  const lines: string[] = [];
  printSlackManifest((line) => lines.push(line));
  const printed = lines.join("\n");
  expect(printed.startsWith("_metadata:")).toBe(true);
  expect(printed).toContain("SLACK_BOT_TOKEN   xoxb-");
  expect(printed).toContain("SLACK_APP_TOKEN   xapp-");
  expect(printed).toContain("connections:write");
});
