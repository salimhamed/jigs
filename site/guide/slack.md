# Slack

A factory talks to Slack through its own Slack app, which always posts as its
own bot. Each factory gets its own app, so one person's factory never posts as
another's. This page sets the app up and connects it to the factory.

## 1. Create the app

In Slack, go to [api.slack.com/apps](https://api.slack.com/apps), choose
**Create New App** → **From a manifest**, pick your workspace, and paste this
manifest. Replace `<name>` with your own name, so colleagues can tell whose
factory is talking:

```yaml
display_information:
  name: "<name>'s jigs"
features:
  bot_user:
    display_name: "<name>'s jigs"
    always_online: true
oauth_config:
  scopes:
    bot:
      - channels:history
      - groups:history
      - chat:write
      - users:read
      - users:read.email
settings:
  event_subscriptions:
    bot_events:
      - message.channels
      - message.groups
  socket_mode_enabled: true
  org_deploy_enabled: false
  token_rotation_enabled: false
```

| Bot scope | What jigs uses it for |
| --- | --- |
| `channels:history` | Reading messages in public channels the bot is in. |
| `groups:history` | Reading messages in private channels the bot is in. |
| `chat:write` | Posting messages and thread replies. |
| `users:read` | Looking up the names of the people who wrote a message. |
| `users:read.email` | Looking up their email addresses. |

Some workspaces require an admin to approve new apps. If yours does, Slack asks
for approval when you install.

## 2. Install it and create the tokens

1. Under **OAuth & Permissions**, choose **Install to Workspace**. Copy the
   **Bot User OAuth Token** (it starts with `xoxb-`).
2. Under **Basic Information** → **App-Level Tokens**, choose
   **Generate Token and Scopes**, add the `connections:write` scope, and
   generate it. Copy the token (it starts with `xapp-`). You only need it with
   Socket Mode on.
3. Put both in the factory's `.env`:

   ```sh
   SLACK_BOT_TOKEN=xoxb-...
   SLACK_APP_TOKEN=xapp-...
   ```

If you add a scope to the app later, reinstall it to the workspace for the
scope to reach the bot token. An app-level token's scopes cannot be changed,
so generate a new one instead.

## 3. Invite the bot to channels

The bot only sees channels it is a member of. In each channel the factory
should watch, public or private, type `/invite @<name>'s jigs`. jigs never reads
direct messages.

## 4. Configure the factory

Add a `slack` section to `jigs.config.ts`:

```ts factory-options
// Inside defineFactory({ ... }) in jigs.config.ts
slack: { socketMode: true },
```

With `socketMode: false`, `SLACK_APP_TOKEN` is not needed.

A workflow that uses Slack declares it:

```ts
import type { WorkflowDefinition } from "@jigs-ai/jigs";

const requires = {
  integrations: ["slack"],
} satisfies WorkflowDefinition["requires"];
```

Run `pnpm exec jigs up` to rebuild and restart the service.

## Start runs from messages

An event trigger starts one run per message. Pick one of two sources:

| Source | Starts a run for |
| --- | --- |
| `slack.messages({ channels })` | Every top-level message in the channels. |
| `slack.mentions({ channels })` | Only top-level messages that mention the bot, such as `@<name>'s jigs`. |

List channels by ID, such as `C0123ABCD`, not by name. Slack shows a channel's
ID at the bottom of its details. The bot must be a member of each one.

```ts
// jigs.config.ts
import { defineFactory, slack } from "@jigs-ai/jigs";

export default defineFactory({
  service: { dashboardPort: 3456 },
  workflows: { answer: () => import("./workflows/answer/answer.ts") },
  slack: { socketMode: true },
  triggers: {
    "answer-questions": {
      workflow: "answer",
      source: slack.mentions({ channels: ["C0123ABCD"] }),
    },
  },
});
```

Each run
gets the inputs `{ channel, ts }`, the message's channel and timestamp, merged
over the trigger's own `inputs`. They are a reference: the run reads the
message itself. The workflow's inputs must accept them:

```ts
// workflows/answer/answer.ts
import { defineWorkflow, type WorkflowInputs } from "@jigs-ai/jigs";
import { z } from "zod";

const inputs = z.object({ channel: z.string(), ts: z.string() });

export async function answer(input: WorkflowInputs<typeof inputs>) {
  "use workflow";
  return { channel: input.channel, ts: input.ts };
}

export default defineWorkflow({
  inputs,
  requires: { integrations: ["slack"] },
  workflow: answer,
});
```

Only top-level messages count. Thread replies, edits, deletes, channel joins
and any other message with a subtype never start a run, and neither do the
bot's own posts. Direct messages are never read.

Each message starts at most one run, whether it arrives over Socket Mode, by
polling or both, and however often Slack sends it again. A new trigger starts
with messages posted after the service first runs it. After the service was
down, it starts runs only for messages from the last 60 minutes; set the
trigger's `lookbackMinutes` to change that. At most 3 of a trigger's runs are
active at once, and later messages wait their turn; set `maxActive` to change
that.

## Checks

`jigs doctor`, and `jigs up`, check that Slack accepts `SLACK_BOT_TOKEN` and
that the bot holds every scope above. With `socketMode` on, they also check
that `SLACK_APP_TOKEN` can open a Socket Mode connection. Each failure names the
missing scope or `.env` key. Before every run of a workflow that requires
`slack`, preflight checks the bot token and its scopes.

With `socketMode` on and `SLACK_APP_TOKEN` empty, the service refuses to start.
