# jigs

[![npm](https://img.shields.io/npm/v/@jigs-ai/jigs)](https://www.npmjs.com/package/@jigs-ai/jigs)

jigs runs repeatable, durable workflows for coding agents. Your workflows live in
a factory repo that runs its own service, with its own Postgres and a dashboard
that shows every run step by step.

Documentation: <https://salimhamed.github.io/jigs/>

## Install

jigs is on public npm as `@jigs-ai/jigs`. Each factory pins its own version, so
nothing is installed globally. You need Node 24 or newer, pnpm and Docker.

## Quick start

```sh
mkdir my-factory && cd my-factory && git init
pnpm --config.minimum-release-age-exclude=@jigs-ai/jigs dlx @jigs-ai/jigs init
pnpm install
cp .env.example .env
pnpm exec jigs up
```

`jigs up` starts Postgres and the service, checks the factory, and ends by
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

## License

Jigs is licensed under the [Business Source License 1.1 (BSL 1.1)](LICENSE).
It is source available and becomes open source under the Apache License 2.0
four years after each version is first publicly distributed.

The Additional Use Grant permits free internal and production use, including
internal modifications, building and operating commercial products, and
consulting, development, integration, and support services for clients.

The grant excludes production use to offer Jigs itself, or a substantially
similar product or service primarily derived from Jigs, to third parties as a
commercial hosted, managed, SaaS, white-labeled, or standalone product or
service. Commercial applications that merely use Jigs as an internal component
or development tool are permitted. These limits apply to the Additional Use
Grant; the BSL's existing rights to copy, modify, create derivative works,
redistribute, and make non-production use remain intact. Uses outside the grant
are subject to the standard BSL terms and may require a commercial license from
the licensor. See [LICENSE](LICENSE) for the full terms.
