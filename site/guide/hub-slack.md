# Slack app

Factories talk to Slack as a Slack app your [hub](/guide/hub) holds. The app
always posts as its own bot. The hub receives the app's events and hands
factories its bot token.

## 1. Create the app in Slack

At [api.slack.com/apps](https://api.slack.com/apps), choose **Create New
App → From scratch**, name it and pick your workspace. Leave **Socket Mode**
off. Under **Basic Information**, note the **App ID**, **Client ID**,
**Client Secret** and **Signing Secret**.

## 2. Add the app to the hub

In the hub, under **Apps → Add a Slack app**, enter the app's name as Slack
shows it, and its App ID, client ID, client secret and signing secret.

## 3. Finish the app's settings

The app's page on the hub shows its **Request URL**, ending in
`/webhooks/slack`, and its **Redirect URL**, ending in
`/oauth/slack/<id>/callback`. In the app's settings in Slack:

- Under **Event Subscriptions**, turn events on and set the Request URL.
  Slack checks it with the hub at once. Under **Subscribe to bot events**, add
  `message.channels` and `message.groups`, and save.
- Under **OAuth & Permissions**, add the Redirect URL and save. Leave
  **token rotation** off: the hub keeps the bot token and has no way to
  refresh one that expires.

## 4. Choose the bot scopes {#bot-scopes}

The app's page on the hub lists the bot scopes installing asks a workspace
for. It starts with every scope jigs uses:

| Bot scope | What jigs uses it for |
| --- | --- |
| `channels:history` | Reading messages in public channels the bot is in. |
| `groups:history` | Reading messages in private channels the bot is in. |
| `chat:write` | Posting messages and thread replies. |
| `users:read` | Looking up the names of the people who wrote a message. |
| `users:read.email` | Looking up their email addresses. |
| `reactions:write` | Adding and removing emoji reactions. |
| `files:write` | Uploading files. |

Every factory's Slack app needs these, so the hub refuses a list that leaves
one out. Add any other scope a factory's own Slack calls need, such as
`pins:write`, and save. Install the app again in each workspace after changing
them. A call that needs a scope the workspace did not grant fails with
Slack's `missing_scope` error.

## 5. Install the app

On the app's page on the hub, choose **Add to Slack** and approve. Some
workspaces require an admin to approve new apps; Slack asks for approval if
yours does. The workspace then appears under **Workspaces**, with the scopes
it granted. Give it an [installation name](/guide/hub#installation-names),
such as `slack-acme`, under **Installation name**, and save.

Invite the bot to each channel factories should hear, public or private, with
`/invite @<bot name>`. jigs never reads direct messages.

## 6. Assign it to factories

Under **Factories** on the app's page, check each factory that should use
this app, and save. A factory may be assigned several Slack apps, even in one
workspace, and names the installation it uses in each trigger and step; see
[one Slack app per teammate](/guide/hub#example-per-person).

To use Slack from a factory, see [Slack](/guide/slack).
