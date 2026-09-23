---
layout: home
title: Repeatable workflows for coding agents
hero:
  name: jigs
  text: Repeatable workflows for coding agents.
  tagline: Connect agents, model calls, and human decisions in TypeScript. Keep your process in your own code, with a recorded history of every run.
  actions:
    - theme: brand
      text: Get started
      link: /guide/getting-started
    - theme: alt
      text: Understand how it works
      link: /guide/what-is-jigs
    - theme: alt
      text: Explore the API
      link: /api/
features:
  - title: Your process, in your code
    details: Write a small workflow for an investigation, or adopt the ship recipe for implementing and reviewing software changes. You decide the steps and policies.
    link: /guide/concepts
    linkText: Learn the core concepts
  - title: Progress that survives a wait
    details: Durable steps record their results. A workflow can wait for a human reply or pull-request review, then continue using the work already recorded.
    link: /guide/human-approval
    linkText: Bring a human into the workflow
  - title: See what is happening
    details: Follow runs from the command line or inspect their step history in your factory’s dashboard. Waiting runs tell you what needs attention.
    link: /guide/operations
    linkText: Run and monitor workflows
---

## Start small, then make it yours

For a ticket describing a bug, the ship recipe can ask for clarification, have
an agent implement the fix, get an independent agent review, and follow the pull
request through CI and human approval. You choose the agents, budgets, and merge
policy in your factory.

Your first workflow creates a scratch directory, removes it, and returns a message.
It proves your service is working before you add repository access, tickets, or
agent prompts. From there, [run an agent](./guide/agents),
[ask a model](./guide/models), or [adopt the ship recipe](./guide/ship).

## What you will need

jigs runs on your machine with Node.js 24 or newer, pnpm, Docker, and installed,
authenticated Claude Code and Codex CLIs. jigs installs from npm as `@jigs-ai/jigs`.

The [getting started guide](./guide/getting-started) walks through those requirements
and your first run. You do not need Linear or a target GitHub repository for that run.
