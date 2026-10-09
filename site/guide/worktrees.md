# Developing in worktrees

You can run several copies of one factory on one machine, such as your main
checkout and a git worktree for each change you work on. Every copy runs the
same `jigs.config.ts`. What differs is each copy's environment: its ports, its
Postgres, its hub token, and which triggers and schedules are
[active](/guide/configuration#active). See [The environment](/guide/configuration#env)
for how a copy loads it.

A new copy is safe by default. Every trigger and schedule you don't turn on in
it stays off, so it never answers in production channels or fires production
schedules.

## Once per engineer: a dev factory on the hub

A copy that uses GitHub, Linear, Slack or PagerDuty needs its own factory on
the [hub](/guide/hub), with its own token. Two copies that share a token share
one place in the hub's event list, so each gets only some of the events.

1. In the hub, under **Factories**, [add a factory](/guide/hub#factories)
   named for you, such as `alice-dev`.
2. On its **Settings** tab, connect the same apps as your production factory.
3. Keep the token the hub shows. Your worktrees use it, one at a time: two
   running copies with the same token would split its events.

The dev factory hears everything production hears, but only the triggers a
copy turns on start runs, so it acts only where you point it.

A copy whose workflows use none of these providers needs no hub token at all.

## For each worktree

From the main checkout:

```sh
git worktree add ../my-factory-feature
cd ../my-factory-feature
pnpm install
cp ../my-factory/.env .
```

`.env` holds the values every copy shares, such as API keys, so copy it as it
is. Then write `.env.local` with this copy's own values:

```sh
# .env.local
COMPOSE_PROJECT_NAME=my-factory-feature
JIGS_SERVICE_PORT=8901
JIGS_DASHBOARD_PORT=9001
JIGS_POSTGRES_PORT=5401
WORKFLOW_POSTGRES_URL=postgres://jigs:jigs@localhost:5401/jigs
JIGS_HUB_TOKEN=<your dev factory's token>
ANSWER_QUESTIONS_ACTIVE=true
ANSWER_CHANNEL=C0TESTCHAN
```

- Pick ports and a compose project no other copy on the machine uses.
  `WORKFLOW_POSTGRES_URL` names the same port as `JIGS_POSTGRES_PORT`.
- Turn on only the trigger or schedule you are working on, with its own
  `*_ACTIVE=true`, plus any value it reads that should differ in this copy,
  such as a test channel.
- Leave out `JIGS_HUB_TOKEN` if nothing active uses a provider.

Then start it:

```sh
pnpm exec jigs up
```

`jigs status` lists every trigger and schedule with its `STATE`, so you can
check that only the one you turned on is active.

Stop the copy with `pnpm exec jigs down` before you remove the worktree. Its
Postgres data stays in the Docker volume `<COMPOSE_PROJECT_NAME>_postgres-data`
until you remove it with `docker volume rm`.
