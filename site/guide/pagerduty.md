# PagerDuty

A factory talks to PagerDuty through a PagerDuty app that its
[hub](/guide/hub) holds and assigns to it. jigs reads incidents
and adds notes to them as the app, never with a person's API key. The hub
receives the app's incident events and hands the factory its tokens, so the
factory's `.env` holds no PagerDuty secret.

## 1. Set up the app in the hub

Register the PagerDuty app, add it to the hub with its webhook subscription
and from email, name the account's installation, such as `pagerduty-acme`, and
assign the app to the factory: see [PagerDuty app](/guide/hub-pagerduty).
Every note jigs adds is attributed to that from user.

Nothing about the app goes in `jigs.config.ts`. Every PagerDuty trigger, step
and agent takes the `installationName` it acts through.

## 2. Check the setup

`pnpm exec jigs doctor` checks, whenever the factory uses PagerDuty, that each
PagerDuty installation it names, and every named one assigned to it, gives the
factory a token that can list incidents.

A workflow that lists `pagerduty` in `requires.integrations` gets the same
check before every run, and a run does not start while it fails:

```ts
// workflows/respond/respond.ts
import { defineWorkflow } from "@jigs-ai/jigs";
import { z } from "zod";

export default defineWorkflow({
  inputs: z.object({ installationName: z.string(), incident: z.string() }),
  requires: { integrations: ["pagerduty"] },
  workflow: async ({ incident }) => incident,
});
```

Each failure ends with a repair line naming what to fix in the hub, in
PagerDuty or in `jigs.config.ts`.

## 3. Start a run for each new incident

An [event trigger](/guide/configuration#triggers) on the `pagerduty.incidents`
source starts one run for each new incident. This one starts the
`respond` workflow above for every high-urgency incident on one service:

```ts
// jigs.config.ts
import { defineFactory, pagerduty } from "@jigs-ai/jigs";

export default defineFactory({
  hub: { url: "https://hub.example.com" },
  service: { port: 8990, dashboardPort: 9090 },
  workflows: {
    respond: () => import("./workflows/respond/respond.ts"),
  },
  triggers: {
    "checkout-pages": {
      workflow: "respond",
      source: pagerduty.incidents({
        installationName: "pagerduty-acme",
        services: ["PABC123"],
        urgencies: ["high"],
      }),
    },
  },
});
```

- `services` and `teams` take PagerDuty service and team IDs, and `urgencies`
  takes `high` or `low`. Each list matches any of its values, and one you leave
  out does not filter.
- Each run gets `{ installationName: "pagerduty-acme", incident: "<id>" }`,
  merged over the trigger's `inputs`. The workflow reads the incident itself,
  through that installation.
- The trigger takes only incidents from its own installation.
- An incident starts at most one run, ever. One that is still triggered after
  its run ends does not start another, and neither does acknowledging and
  re-triggering it.
- The run starts as soon as the hub passes on PagerDuty's `incident.triggered`
  event. The hub keeps the events that arrive while the service is down.
- Every new incident starts a run, even one acknowledged or resolved before the
  service saw it. The workflow can check the status in its snapshot and skip an
  incident that is already handled.

