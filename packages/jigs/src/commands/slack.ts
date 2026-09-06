// The Slack app a factory creates for itself, printed rather than installed:
// creating an app is a one-time browser step nobody automates, and a manifest
// is what that page takes as input.

// Verified against the app-manifest schema (docs/research/slack-connection-notes.md).
// `request_url` is deliberately absent — Slack rejects it under Socket Mode.
// The scopes are the minimum: `*:history` gates the message events and
// thread reads, `*:read` gates conversations.info, and all four channel kinds
// are here because a channel id does not say which kind it is.
export const SLACK_APP_MANIFEST = `_metadata:
  major_version: 2
  minor_version: 1
display_information:
  name: jigs
features:
  bot_user:
    display_name: jigs
    always_online: false
  app_home:
    home_tab_enabled: false
    messages_tab_enabled: true
    messages_tab_read_only_enabled: false
oauth_config:
  scopes:
    bot:
      - app_mentions:read
      - channels:history
      - channels:read
      - groups:history
      - groups:read
      - im:history
      - im:read
      - mpim:history
      - mpim:read
      - chat:write
settings:
  event_subscriptions:
    bot_events:
      - app_mention
      - message.channels
      - message.groups
      - message.im
      - message.mpim
  org_deploy_enabled: false
  socket_mode_enabled: true
  token_rotation_enabled: false
`;

export const SLACK_TOKEN_FOOTER = `# Create the app from this manifest at https://api.slack.com/apps → Create New
# App → From a manifest, install it to the workspace, then put both tokens in
# the factory repo's .env:
#
#   SLACK_BOT_TOKEN   xoxb-…  OAuth & Permissions → Bot User OAuth Token (install the app first)
#   SLACK_APP_TOKEN   xapp-…  Basic Information → App-Level Tokens → Generate, scope: connections:write
#
# Then declare the channel and the allowlist under \`slack:\` in jigs.yml and
# restart the service.`;

export function printSlackManifest(out: (line: string) => void): void {
  out(SLACK_APP_MANIFEST.trimEnd());
  out("");
  out(SLACK_TOKEN_FOOTER);
}
