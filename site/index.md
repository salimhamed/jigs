---
layout: home
title: jigs
hero:
  name: jigs
  tagline: Repeatable workflows for coding agents
  actions:
    - theme: brand
      text: Get started
      link: /guide/why-jigs
---

## What jigs is

jigs runs durable TypeScript workflows that combine coding agents, model calls,
questions for a person and operations such as opening a pull request. A run
waits for a reply, a review or a CI build and continues where it left off.
Your workflows live in a **factory repo** that installs jigs from npm as
`@jigs-ai/jigs`. Create one with
`pnpm --config.minimum-release-age-exclude=@jigs-ai/jigs dlx @jigs-ai/jigs init`,
then follow [Install and run a first workflow](/guide/getting-started).

## Getting started for agents

Install the jigs skill, which adds a single skill named `/jigs`:

```sh
npx skills add salimhamed/jigs
```

Then ask your agent `/jigs set up a factory in this empty directory`. To give
an agent the docs, point it at
<https://salimhamed.github.io/jigs/llms.txt> (every page) or
<https://salimhamed.github.io/jigs/llms-full.txt> (the whole site in one file).
