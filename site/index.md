---
layout: home
title: jigs
hero:
  name: jigs
  tagline: Repeatable workflows for coding agents
  actions:
    - theme: brand
      text: Get started
      link: /guide/getting-started
---

## What is jigs?

**jigs turns one-off AI interactions into repeatable workflows.** Combine coding
agents, models, deterministic code, human input, and external events in
TypeScript, then let the workflow coordinate the process for you.

AI makes individual tasks easier to automate. Workflows make the larger process
explicit and repeatable: what happens, what runs where, when human judgment is
needed, and what can continue automatically.

Workflows live in your own **factory** repository, which installs jigs and runs
the service that executes and tracks them.

## Set up with a coding agent

The fastest way to get started is to let your coding agent do the setup.

```sh
npx skills add salimhamed/jigs
```

Then ask your agent:

```text
/jigs set up a factory in this empty directory
```

## Using these docs with a coding agent?

Give your agent [llms.txt](https://salimhamed.github.io/jigs/llms.txt) for the
documentation index and links to individual pages, or
[llms-full.txt](https://salimhamed.github.io/jigs/llms-full.txt) for the complete
documentation in one file.
