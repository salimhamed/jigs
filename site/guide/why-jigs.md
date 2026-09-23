# Why jigs

Coding agents are capable but not repeatable. Ask one to take a ticket to a
merged pull request twice and it may take two different routes, skip a check,
or forget where it stopped when the session ends. The process lives in a prompt
and in the agent's memory, and both drift.

A workflow writes that process down as code. Every run follows the same steps,
in the same order, with the agent doing only the parts that need judgment. The
run waits for a person, a review or a CI build without losing its place, and it
leaves a record of what happened. That is what jigs gives you: the flexibility
of agents inside a process you can trust and rerun.

## Built on the Vercel Workflow SDK

jigs runs on the [Vercel Workflow SDK](https://useworkflow.dev). A workflow is
an async function marked `"use workflow"`; a step is a function marked
`"use step"`. The SDK records each finished step, so a run that pauses or
restarts resumes where it was and never repeats completed work.

A workflow is ordinary TypeScript. It can call jigs' building blocks, such as
`runAgent` or `openPullRequest`, but it does not have to: any code and
any library can go in it, within the SDK's rules for workflows and steps.

Your workflows live in a **factory repo**, a repository of your own that
installs jigs as a package. The factory runs its own service on your machine,
with its own Postgres database and a dashboard of every run.

## Features

- **Several repositories per factory**, each run in its own Git worktree.
- **Linear tickets and human questions**: claim a ticket, ask on it, pause for the reply.
- **Claude Code, Codex and Pi harnesses**, or a model API called directly.
- **Your existing Claude and Codex subscriptions** pay for agent work.
- **Optional webhooks**: waiting runs poll GitHub and Linear without them.
