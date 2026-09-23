# Use the ship recipe

The ship recipe is a complete software-delivery workflow. It reads a Linear
ticket, runs implementation and independent review, opens a pull request, and
follows feedback and CI until merge or closure.

It is optional. Copy it when you want this process; write your own workflow when
you need something different. Once copied, its code belongs to your factory.

## 1. Copy and register it

Inside your factory, run:

```sh
pnpm exec jigs recipe list
pnpm exec jigs recipe add ship
```

Add the following entry to the existing `workflows` object in `jigs.config.ts`:

```ts
ship: () => import("./workflows/ship.ts"),
```

The command preserves existing files and reports which files it creates or keeps.
Registration is a separate, explicit edit.

## 2. Configure its integrations

Follow the [setup runbook](https://github.com/salimhamed/jigs/blob/main/docs/setup.md)
to configure GitHub identity, Linear credentials, webhook delivery, and merge
policy. Decide who is allowed to merge and what counts as approval before
launching a delivery run.

Bind the repository the agent will work on, replacing the URL with yours:

```sh
pnpm exec jigs bind git@github.com:owner/repo.git
pnpm exec jigs doctor
pnpm exec jigs up
```

Fix any problems reported by `doctor`. The binding name normally comes from the
repository name; check the resulting `bindings` entry in `jigs.config.ts`.

## 3. Launch a delivery

Replace the ticket and binding with your own values:

```sh
pnpm exec jigs run ship --input ticket=AGE-123 --input binding=repo
pnpm exec jigs watch
```

The workflow may ask questions on the ticket or wait for pull-request review.
[Inspect its status](./operations) to see what needs attention.

## Choose the agents

By default Codex implements the change and Claude Code reviews it. Pick a
different harness or model for a run with inputs:

```sh
pnpm exec jigs run ship --input ticket=AGE-123 --input binding=repo \
  --input implementationHarness=claude --input implementationModel=sonnet
```

`implementationHarness` and `reviewHarness` accept Claude Code (`claude`) and
Codex (`codex`) by name. A model left unset takes that harness's default, which
the copied workflow keeps in its own `inputHarnesses` map. Pi is listed too, but
choosing it fails before the run starts: a Pi role needs a
[model source](./models-and-harnesses#pi), so you build it in
`workflows/ship.ts` with `harnesses.pi(...)` and add `"pi"` to the workflow's
`requires.harnesses`.

The ship workflow calls no model source directly, so it declares no
`requires.models`. Agents start with only a small base environment; list any
extra variable your repository's tools need under `agents: { env }` in
`jigs.config.ts`, as described in
[harness environment](./models-and-harnesses#harness-environment).

## Make the process yours

The copied files include delivery phases, prompts, types, and tests in
`blocks/delivery/`. You can choose agent models, change prompts, set review and
repair budgets, or compose the phases differently. Upgrading jigs does not
overwrite this code.

For these options and worked examples, read the
[detailed ship recipe guide](https://github.com/salimhamed/jigs/blob/main/docs/delivery.md).
