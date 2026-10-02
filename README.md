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
The production-use grant permits free internal use, commercial development,
personal projects, and open-source use, but excludes offering Jigs or a
substantially similar derivative as a commercial hosted or standalone product
or service to third parties.
Each version converts to Apache License 2.0 four years after its first public
release.
Versions released before this licensing change remain available under MIT.

For commercial licensing, [open a licensing inquiry](https://github.com/salimhamed/jigs/issues/new?title=Commercial%20licensing%20inquiry).

This summary is for convenience; [LICENSE](LICENSE) controls.
