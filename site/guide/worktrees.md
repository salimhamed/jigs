# Developing in worktrees

You can run several copies of one factory on one machine, each with its own
[environment](/guide/configuration#env).

A trigger or schedule that reads `active` from the environment, as the examples
do, stays off in a new copy until that copy turns it on.

## Once per engineer: a dev factory on the hub

1. In the [hub](/guide/hub), under **Factories**,
   [add a factory](/guide/hub#factories) named for you, such as `alice-dev`.
2. On its **Settings** tab, connect the same apps as your production factory.
3. Keep the token the hub shows; one running copy uses it at a time. Two
   copies with one token split its events between them.

A copy with no active trigger, whose workflows and bindings use none of these
providers, needs no token.

## For each worktree

Say production answers questions in a Slack channel, and you are changing
that. The trigger reads both its flag and its channel from the environment:

```ts
import { slack } from "@jigs-ai/jigs";

// In defineFactory's `triggers`.
const triggers = {
  answer: {
    active: process.env.ANSWER_ACTIVE === "true",
    workflow: "answer",
    source: slack.mentions({
      installationName: "slack-acme",
      channels: [process.env.ANSWER_CHANNEL ?? ""],
    }),
  },
};
```

Production's channel can live in the shared `.env`; a copy's `.env.local`
overrides it.

From the main checkout:

```sh
git worktree add ../my-factory-answer
cd ../my-factory-answer
pnpm install
cp ../my-factory/.env . && cp .env.local.example .env.local
```

`.env` holds the values every copy shares, so copy it as it is. In
`.env.local`, change `COMPOSE_PROJECT_NAME` and the three ports, and the port in
`WORKFLOW_POSTGRES_URL`, to ones no other copy uses. Then add your dev
factory's token and turn on the one trigger you are working on, in a test
channel:

```sh
# .env.local
COMPOSE_PROJECT_NAME=my-factory-answer
JIGS_SERVICE_PORT=8899
JIGS_DASHBOARD_PORT=9199
JIGS_POSTGRES_PORT=5499
WORKFLOW_POSTGRES_URL=postgres://jigs:jigs@localhost:5499/jigs
JIGS_HUB_TOKEN=<your dev factory's token>
ANSWER_ACTIVE=true
ANSWER_CHANNEL=C0TESTCHAN
```

Then start it:

```sh
pnpm exec jigs up
```

`jigs status` lists every trigger and schedule with its `STATE`, so you can
check that only `answer` is active.

Stop the copy with `pnpm exec jigs down` before you remove the worktree. Its
Postgres data stays in the Docker volume `<COMPOSE_PROJECT_NAME>_postgres-data`
until you remove it with `docker volume rm`.
