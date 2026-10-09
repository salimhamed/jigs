# PagerDuty app

Factories act on PagerDuty as a PagerDuty app your [hub](/guide/hub) holds.
The app acts as itself in one PagerDuty account, never with a person's API
key. The hub receives the account's incident events and mints a fresh token
each time a factory asks for one.

An account admin or owner registers the app once per PagerDuty account.

## 1. Register the app in PagerDuty

1. In PagerDuty, go to **Integrations → App Registration** and choose
   **New App**. Give it a name such as `jigs`, turn on **OAuth 2.0** and
   choose **Scoped OAuth**. The redirect URL is never used; enter your hub's
   address.
2. Grant these permission scopes:

   | Scope | What jigs uses it for |
   | --- | --- |
   | `incidents.read` | Reading incidents, and the preflight check. |
   | `incidents.write` | Adding notes to incidents. |
   | `users.read` | Checking the from user exists when you save it on the hub. |

3. Save, and note the app's **Client ID** and **Client Secret**.

## 2. Add the app to the hub

In the hub, under **Apps → Add app**, choose **PagerDuty app**, and enter the
app's name, which only labels it on the hub, its client ID and client secret,
the account's subdomain (the `<subdomain>` in `<subdomain>.pagerduty.com`),
its region, US or EU, and the **from email**.

The from email is a real user on the account. PagerDuty attributes every
change jigs makes, such as a note on an incident, to this person, so pick a
user whose name reads well on an incident timeline, such as a shared on-call
account. The hub gets a token for the account and checks that a user has
this email before it saves. Change it later under **Account** on the app's
page; the hub checks it again.

Then give the account an [installation name](/guide/hub#installation-names),
such as `pagerduty-acme`, under **Installation name** on the app's page.

## 3. Add the webhook subscription

The app's page on the hub shows its **Webhook URL**, ending in
`/webhooks/pagerduty/<id>`. In PagerDuty, under **Integrations → Generic
Webhooks (v3)**, add a subscription:

- **Webhook URL**: the one the hub shows.
- **Scope**: the account, or the services or teams your factories watch.
- **Event subscription**: `incident.triggered`.

PagerDuty shows the subscription's **signing secret** once, when you create
it. Enter it on the app's page on the hub, which warns at the top until you
do: until then, the hub refuses the app's webhooks.

## 4. Assign it to factories

On the **Settings** tab of each factory that should use this app, choose
**Connect app** and connect the app. A factory may be assigned several
PagerDuty accounts, and names the installation it uses in each trigger, step
and agent.

A missing scope does not stop the hub from getting a token. It shows up as a
refused call, and `jigs doctor` names the scope to add. To use PagerDuty from
a factory, see [PagerDuty](/guide/pagerduty).
