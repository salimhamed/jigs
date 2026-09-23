---
layout: home
title: jigs
hero:
  name: jigs
  text: Repeatable workflows for coding agents
  actions:
    - theme: brand
      text: Get started
      link: /guide/getting-started
---

## What jigs is

jigs runs TypeScript workflows that combine coding agents, model calls, human
questions and ordinary operations such as creating a Git worktree or opening a
pull request. A workflow keeps its progress while it waits for a person, a
review or a CI build, and picks up where it left off.

## How it runs

You keep your workflows in a **factory repo**: your own repository that installs
jigs from npm as `@jigs-ai/jigs`. Each factory runs its own service on your
machine, with its own Postgres database, and hosts a dashboard showing every
run's history. The repositories your agents change are connected to the factory
by name, and jigs cuts a separate worktree for each run.

## How to use it

Create a factory with `pnpm dlx @jigs-ai/jigs init`, start it with `jigs up`,
and run the included `hello` workflow. Then write your own workflows, or copy in
a recipe such as **ship**, which takes a Linear ticket to a merged pull request.
The [getting started guide](/guide/getting-started) walks through it.

## Set up with your agent

Install the jigs skill into your coding agent:

```sh
npx skills add salimhamed/jigs
```

Then ask it, for example: "Use /jigs to set up a jigs factory in this empty
directory." The same skill can run and watch workflows, write new ones, and
answer questions about jigs.

## Give your agent the docs

Point an agent at the documentation written for it:

- <https://salimhamed.github.io/jigs/llms.txt> lists every page.
- <https://salimhamed.github.io/jigs/llms-full.txt> holds the whole site in one file.
