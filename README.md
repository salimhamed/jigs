# jigs

[![npm](https://img.shields.io/npm/v/@jigs-ai/jigs)](https://www.npmjs.com/package/@jigs-ai/jigs)

jigs runs repeatable, durable workflows for coding agents. Your workflows live in
a factory repo that runs its own service, with its own Postgres and a dashboard
that shows every run step by step. Factories hear GitHub, Linear, Slack and
PagerDuty through a hub, one service that receives every provider event and
holds every credential for your factories. A factory that uses none of them
needs no hub.

Documentation: <https://salimhamed.github.io/jigs/>

## Install

jigs is on public npm as `@jigs-ai/jigs`. Each factory pins its own version, so
nothing is installed globally. You need Node 24 or newer, pnpm and Docker. Once
a workflow uses GitHub, Linear, Slack or PagerDuty, you also need a hub with
your factory added to it: see
[Run a hub](https://salimhamed.github.io/jigs/guide/hub).

## Quick start

```sh
mkdir my-factory && cd my-factory && git init
pnpm --config.minimum-release-age-exclude=@jigs-ai/jigs dlx @jigs-ai/jigs init
pnpm install
cp .env.example .env
$EDITOR .env.local
pnpm exec jigs up
```

`.env` holds the values every copy of the factory shares. `.env.local` holds
this copy's own, such as its ports: uncomment them from the end of
`.env.example`. `jigs up` starts Postgres and the service, checks the factory, and ends by
listing what it started, with the dashboard URL. Then run the starter workflow:

```sh
pnpm exec jigs run hello
pnpm exec jigs status
```

The [getting started guide](https://salimhamed.github.io/jigs/guide/getting-started)
explains each step.

## Set up with your agent

Install the jigs skill for your coding agent. It adds a single skill named `/jigs`:

```sh
npx skills add salimhamed/jigs
```

Then ask it `/jigs set up a factory in this empty directory`.

## Development

See [docs/contributing.md](docs/contributing.md).
