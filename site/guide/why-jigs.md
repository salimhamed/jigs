# Why jigs

AI is making more and more individual tasks automatable. But real work is
usually a process: implement something, review it, run checks, wait for
feedback, and decide what happens next.

**jigs exists to automate the process between those tasks.**

## Workflows connect the work

A workflow defines how work moves from step to step. One step might use Claude
Code, another Codex, another a direct model call, deterministic TypeScript,
human input, or an external event.

The workflow connects those pieces so the process can continue automatically
instead of requiring someone to manually drive each transition.

## Not tied to one agent or repository

Workflows live above the tools that execute them.

They can combine different agent harnesses, hosted or local models, and
ordinary code. They can also work across multiple repositories or automate
something that does not involve a repository at all.

## Pause and continue

Real processes don't always execute from beginning to end in one uninterrupted
session. They wait for reviews, CI, people, pull requests, tickets, and other
external events.

Workflows can pause and resume later without losing their place, and webhooks
can wake them as soon as something changes.

jigs builds on the [Vercel Workflow SDK](https://useworkflow.dev) to provide this
durable execution model.

## Local by design

jigs runs locally so workflows can work directly with your repositories,
development tools, credentials, agent subscriptions, and local models.

Your workflows live in a **factory**: a TypeScript repository you own that
installs jigs and defines the processes you want to automate.
