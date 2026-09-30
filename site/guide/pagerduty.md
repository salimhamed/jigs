# PagerDuty

jigs talks to PagerDuty as an app registered on your account. It reads
incidents and adds notes to them. It never uses a person's API key: the app gets
its own token from its client ID and secret, keeps it in memory only and gets a
new one when PagerDuty stops accepting it.

## 1. Register a scoped OAuth app

An account admin or owner does this once per PagerDuty account.

1. In PagerDuty, go to **Integrations → App Registration** and choose
   **New App**. Give it a name such as `jigs`.
2. Turn on **OAuth 2.0** and choose **Scoped OAuth**. jigs uses the client
   credentials grant, so any redirect URL will do.
3. Grant these permission scopes:

   | Scope | What jigs uses it for |
   | --- | --- |
   | `incidents.read` | Reading and listing incidents, and the preflight check. |
   | `incidents.write` | Adding notes to incidents. |
   | `webhook_subscriptions.read` | Checking the webhook that delivers incident events. |
   | `services.read` | Reading the services incidents belong to. |
   | `users.read` | `jigs doctor`'s check of the `from` user. |

4. Register the app and copy its **client ID** and **client secret**. PagerDuty
   shows the secret only once.

PagerDuty issues a token with only the scopes the app was granted. A missing
scope does not stop jigs from getting a token. It shows up as a refused call,
and `jigs doctor` names the scope to add.

## 2. Put the credentials in `.env`

```sh
PAGERDUTY_CLIENT_ID=...
PAGERDUTY_CLIENT_SECRET=...
```

Keep them out of version control. jigs never writes its token to disk and never
prints either secret.

## 3. Configure the account and the `from` user

Add a `pagerduty` section to `jigs.config.ts`:

```ts factory-options
// Inside defineFactory({ ... }) in jigs.config.ts
pagerduty: {
  identity: {
    mode: "app",
    subdomain: "acme",
    region: "us",
    from: "oncall@example.com",
  },
},
```

- `mode` is `app`, the only mode.
- `subdomain` is your account's subdomain alone: `acme` for
  `acme.pagerduty.com`.
- `region` is the account's service region, `us` or `eu`.
- `from` is required: the email of a real user on the account. PagerDuty
  refuses a change that names no user, so every note jigs adds is attributed to
  this person. Pick a user whose name reads well on an incident timeline, such
  as a shared on-call account.

Then run `pnpm exec jigs up`, which rebuilds the factory and restarts the
service.

## 4. Check the setup

`pnpm exec jigs doctor` checks, whenever the factory has a `pagerduty` section:

- **PagerDuty identity**: both `.env` variables are set, PagerDuty issues a
  token for them, and the token can list incidents.
- **PagerDuty from user**: a PagerDuty user has the `from` email.

A workflow that lists `pagerduty` in `requires.integrations` gets the identity
check before every run, and a run does not start while it fails:

```ts
import { defineWorkflow } from "@jigs-ai/jigs";
import { z } from "zod";

export default defineWorkflow({
  inputs: z.object({ incident: z.string() }),
  requires: { integrations: ["pagerduty"] },
  workflow: async ({ incident }) => incident,
});
```

Each failure ends with a repair line naming the `.env` variables, the
`jigs.config.ts` setting or the app scope to fix.
