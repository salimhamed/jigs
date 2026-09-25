# Install and run a workflow

This guide creates a factory, starts its service and runs `hello`, the workflow
every new factory includes.

## Set up with a coding agent

The fastest way to get started is to let your coding agent do the setup.
Install the jigs skill:

```sh
npx skills add salimhamed/jigs
```

Then ask your agent:

```text
/jigs set up a factory in this empty directory
```

The rest of this page shows the same process manually.

## 1. Prerequisites

- **Node.js 24 or newer**
- **pnpm**
- **Docker**, with Docker running

`hello` doesn't use a model or coding agent, so you don't need any model
credentials or agent CLIs yet.

## 2. Create a factory

```sh
mkdir my-factory
cd my-factory
git init
pnpm dlx @jigs-ai/jigs init
```

::: tip Recently published versions
jigs is changing rapidly. If pnpm's minimum release age setting holds back a
recent release, use this variant to exempt jigs from that restriction:

```sh
pnpm --config.minimum-release-age-exclude=@jigs-ai/jigs dlx @jigs-ai/jigs init
```

The exception applies only to jigs. It does not refresh pnpm's `dlx` cache.
:::

`init` writes the starting files without starting the service.
`workflows/hello/hello.ts` contains your first workflow, and `jigs.config.ts`
registers it under the name `hello`.

## 3. Start the service

```sh
pnpm install
cp .env.example .env
pnpm exec jigs up
```

`hello` needs nothing filled in `.env`. `jigs up` starts everything your factory
needs and checks that it is ready. When it finishes, the service and dashboard
are available. Open the dashboard URL it prints to inspect workflow runs and
individual steps.

## 4. Run hello

```sh
pnpm exec jigs run hello
```

`jigs run hello` starts the workflow in the jigs service and gives you a run ID
and dashboard link. The workflow continues independently of the command that
started it. Use the dashboard or `jigs status` to check its progress:

```sh
pnpm exec jigs status
```

Wait for the run to show as completed.

**That's it. You now have a running jigs factory and have completed your first
workflow.**

When you're finished, stop the factory:

```sh
pnpm exec jigs down
```
