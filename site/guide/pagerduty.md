# PagerDuty

A factory talks to PagerDuty through a PagerDuty app that its
[hub](/guide/configuration#hub) holds and assigns to it. jigs reads incidents
and adds notes to them as the app, never with a person's API key. The hub
receives the app's incident events and hands the factory its tokens, so the
factory's `.env` holds no PagerDuty secret.

## 1. Set up the app in the hub

An account admin or owner registers the app once per PagerDuty account.

1. In PagerDuty, go to **Integrations → App Registration** and choose
   **New App**. Give it a name such as `jigs`, turn on **OAuth 2.0** and
   choose **Scoped OAuth**. Any redirect URL will do.
2. Grant these permission scopes:

   | Scope | What jigs uses it for |
   | --- | --- |
   | `incidents.read` | Reading and listing incidents, polling for new ones, and the preflight check. |
   | `incidents.write` | Adding notes to incidents. |
   | `webhook_subscriptions.read` | Reading the webhook subscription that sends incident events. |
   | `users.read` | `jigs doctor`'s check of the `from` user. |

3. In the hub, add a PagerDuty connection with the app's client ID and secret,
   and the account's subdomain and region. Its page then shows the webhook
   subscription to add in PagerDuty and takes the subscription's signing
   secret.
4. Assign the connection to the factory.

A missing scope does not stop the hub from getting a token. It shows up as a
refused call, and `jigs doctor` names the scope to add.

## 2. Configure the `from` user

Add a `pagerduty` section to `jigs.config.ts`:

```ts factory-options
// Inside defineFactory({ ... }) in jigs.config.ts
pagerduty: { from: "oncall@example.com" },
```

`from` is the email of a real user on the account. PagerDuty refuses a change
that names no user, so every note jigs adds is attributed to this person. Pick
a user whose name reads well on an incident timeline, such as a shared on-call
account. A factory that only reads incidents can leave the section out.

Then run `pnpm exec jigs up`, which rebuilds the factory and restarts the
service.

## 3. Check the setup

`pnpm exec jigs doctor` checks, whenever the factory has a `pagerduty` section
or a trigger on a PagerDuty source:

- **hub PagerDuty app**: the hub has assigned the factory a PagerDuty app.
- **PagerDuty app**: the hub hands out a token, and the token can list
  incidents.
- **PagerDuty from user**: a PagerDuty user has the `from` email.

A workflow that lists `pagerduty` in `requires.integrations` gets the app
check before every run, and a run does not start while it fails:

```ts
// workflows/respond/respond.ts
import { defineWorkflow } from "@jigs-ai/jigs";
import { z } from "zod";

export default defineWorkflow({
  inputs: z.object({ incident: z.string() }),
  requires: { integrations: ["pagerduty"] },
  workflow: async ({ incident }) => incident,
});
```

Each failure ends with a repair line naming what to fix in the hub, in
PagerDuty or in `jigs.config.ts`.

## 4. Start a run for each new incident

An [event trigger](/guide/configuration#triggers) on the `pagerduty.incidents`
source starts one run for each new incident. This one starts the
`respond` workflow above for every high-urgency incident on one service:

```ts
// jigs.config.ts
import { defineFactory, pagerduty } from "@jigs-ai/jigs";

export default defineFactory({
  hub: { url: "https://hub.example.com" },
  service: { port: 8990, dashboardPort: 9090 },
  pagerduty: { from: "oncall@example.com" },
  workflows: {
    respond: () => import("./workflows/respond/respond.ts"),
  },
  triggers: {
    "checkout-pages": {
      workflow: "respond",
      source: pagerduty.incidents({ service_ids: ["PABC123"], urgencies: ["high"] }),
    },
  },
});
```

- The parameters are PagerDuty's own list-incidents parameters: `service_ids`,
  `team_ids` and `urgencies`. Each list matches any of its values, and one you
  leave out does not filter.
- Each run gets `{ incident: "<id>" }`, merged over the trigger's `inputs`. The
  workflow reads the incident itself.
- An incident starts at most one run, ever. One that is still triggered after
  its run ends does not start another, and neither does acknowledging and
  re-triggering it.
- The run starts as soon as the hub passes on PagerDuty's `incident.triggered`
  event. The service also asks PagerDuty for new incidents every
  `service.pollIntervalSeconds.pagerduty` seconds (default 300, minimum 30),
  which finds any incident whose event was missed.
- Every new incident starts a run, even one acknowledged or resolved before a
  poll saw it. The workflow can check the status in its snapshot and skip an
  incident that is already handled.

