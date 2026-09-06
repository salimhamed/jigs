# Slack connection research (for AGE-386 PR 1)

Verified 2026-09-05 against docs.slack.dev and the published tarballs of
`@slack/socket-mode@3.0.1` and `@slack/web-api@8.1.1`.

## App manifest (Socket Mode, minimum scopes)

```yaml
_metadata:
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
      - message.channels
      - message.groups
      - message.im
      - message.mpim
  org_deploy_enabled: false
  socket_mode_enabled: true
  token_rotation_enabled: false
```

- Omit `request_url` entirely under Socket Mode; Slack disallows it.
- `*:history` scopes gate both the `message.*` events and `conversations.replies`
  (thread reads need nothing extra). `*:read` scopes gate `conversations.info`;
  include all four because the channel type is unknown before the call.
- `chat:write.public` is NOT needed: the bot only posts where it is invited.
- `app_mention` is deliberately not subscribed to: Slack delivers a channel
  mention as *both* an `app_mention` and a `message.channels`, so a wrapper
  subscribed to both acks and answers one utterance twice. `message.*` covers
  every case — a mention is an ordinary message whose text holds the bot id,
  and `app_mention` never fires in DMs anyway. The manifest above is jigs'
  (mention-free); Slack's own default manifest includes both.
- `auth.test` needs no scopes.

## Tokens (CLI footer text)

```
SLACK_BOT_TOKEN   xoxb-…  OAuth & Permissions → Bot User OAuth Token (install the app first)
SLACK_APP_TOKEN   xapp-…  Basic Information → App-Level Tokens → Generate, scope: connections:write
```

## `@slack/socket-mode` 3.0.1

- Node >= 20. Peer dep `undici ^7` (uses undici WebSocket, not `ws`). Depends on `@slack/web-api ^8`.
- `new SocketModeClient({ appToken, autoReconnectEnabled?: true, clientPingTimeout?: 5000, serverPingTimeout?: 30000, logger?, logLevel?, clientOptions?, dispatcher? })`
- `start(): Promise<AppsConnectionsOpenResponse>` resolves on `connected`, rejects on `disconnected`; `disconnect(): Promise<void>`.
- Lifecycle events: `connecting`, `authenticated`, `connected`, `reconnecting`, `disconnecting`, `disconnected`, `error`, `close`.
- `unable_to_socket_mode_start` is gone in v3: unrecoverable `apps.connections.open` failures (`not_authed`, `invalid_auth`, `account_inactive`, `user_removed_from_team`, `team_disabled`) make `start()` reject and stop retrying. Other failures back off linearly.
- Inbound Events API envelopes are emitted under the INNER event type: `client.on('message', …)`, `client.on('app_mention', …)` (never `message.channels`; use `event.channel_type` = `channel|group|im|mpim`). `slack_event` is the catch-all and the best single subscription point for a wrapper.
- Handler arg: `{ ack, envelope_id, body, event, retry_num, retry_reason, accepts_response_payload }`. `ack(response?)` must be called promptly or Slack redelivers; it rejects with `SMSendWhileDisconnectedError` / `SMSendWhileNotReadyError` / `SMWebsocketError`.
- Minimal injectable surface: `start`, `disconnect`, `on`, `off`, and the envelope shape above.

## `@slack/web-api` 8.1.1

- `new WebClient(token, options?)`; `auth.test()` → `{ ok, team, team_id, user, user_id, bot_id, app_id, url }`.
- `conversations.info({ channel })` → `{ channel: { id, name, is_private, is_im, is_member, is_archived, … } }`.
- Non-ok responses throw `WebAPIPlatformError` with `error.data.error` as the Slack error string (`channel_not_found`, `missing_scope` with `data.needed`/`data.provided`, `invalid_auth`, `not_authed`, `token_revoked`, `account_inactive`, …). Prefer `instanceof WebAPIPlatformError` over `err.code`. `not_in_channel` comes from history/replies/postMessage, not from `conversations.info`.
- `WebClient` emits `rate_limited` on 429s.

Sources: docs.slack.dev reference pages for app-manifest, using-socket-mode,
tokens, apps.connections.open, auth.test, conversations.info, chat.postMessage,
the scope and event reference pages listed above, and the two npm tarballs.
