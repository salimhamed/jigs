# Linear app

Factories act on Linear as a Linear OAuth app your [hub](/guide/hub) holds, so
their comments and mentions reach people like anyone else's. People can
mention the app on an issue or assign an issue to it, as they would a
teammate. The hub receives the app's webhooks, holds each workspace's tokens
and refreshes them.

Use **one Linear app per purpose**. Every factory assigned an app hears every
mention of it, so two factories that share one both act on the same mention.

## 1. Create the app in Linear

In Linear, under **Settings → API → OAuth applications**, create a new
application:

- **Name** and icon: what people see, and the name they mention.
- **Callback URLs**: enter your hub's address for now; you replace it in
  step 3.
- **Webhooks**: turn them on, with your hub's address as the URL for now, and
  choose **Agent session events** and **Comments**.
- **Public**: leave it off, unless workspaces other than yours should connect
  to it.

Save, then note the app's **Client ID**, **Client secret** and **Webhook
signing secret**.

## 2. Add the app to the hub

In the hub, under **Apps → Add a Linear app**, enter the app's name as
Linear shows it, its client ID, client secret and webhook signing secret.

## 3. Finish the app's settings

The app's page on the hub shows its **Callback URL**, ending in
`/oauth/linear/<id>/callback`, and its **Webhook URL**, ending in
`/webhooks/linear/<id>`. Each Linear app has its own. In the app's settings
in Linear, replace the callback URL and webhook URL with these.

## 4. Connect your workspace

On the app's page on the hub, choose **Connect a Linear workspace**. Linear
asks a workspace admin to approve the app; the hub asks for `read` and
`write`, and for the app to be mentionable and assignable, so it can work as
an agent. The workspace then appears under **Workspaces**. Give it an
[installation name](/guide/hub#installation-names), such as
`linear-acme`, under **Installation name**, and save.

If the hub can no longer refresh a workspace's tokens, for example because
the app was revoked in Linear, the workspace shows **Connect again**. Connect
it again to fix it.

## 5. Assign it to factories

Under **Factories** on the app's page, check each factory that should act as
this app, and save. A factory may be assigned several Linear apps and
workspaces, and names the installation it uses in each trigger, step and agent.

In the factory, `pnpm exec jigs doctor` checks that the hub hands it a token
for each Linear installation it uses. To start runs from mentions and assignments, see
[Linear mentions and assignments](/guide/configuration#linear-agent-sessions).
