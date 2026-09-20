# What is jigs?

jigs runs TypeScript workflows that combine coding agents, model calls, and
operations such as creating a working directory or opening a pull request.
It is useful when a process has several steps, may need human input, and should
retain its progress while it waits.

For example, a software change might involve reading a ticket, asking a question,
implementing the change, getting an independent review, and following the pull
request until it merges. The optional [ship recipe](./ship) supplies that process
as code you can edit.

You can also write a much smaller workflow: run an investigation, summarize the
findings with a model, and return a report. Software delivery is one use of jigs,
not a requirement for every workflow.

## Where your code lives

You create a **factory repo**: your own repository of workflows and configuration.
It installs jigs as a package and runs its own service and Postgres database.
The service executes your workflows and hosts a dashboard of their history.

A factory is separate from the repositories an agent changes. You give those
repositories names called **bindings**. jigs maintains a clone for each binding
and creates a separate Git working directory, called a **worktree**, for a run.

## What durability means

The runtime records the results of completed **steps**. When a workflow resumes,
it reuses those recorded results to continue. Closing the terminal that launched
a run does not cancel it; the service does the work.

This does not make every external operation happen exactly once. Failed attempts
can be retried, so custom operations still need to handle retries safely. Your
workflow also decides when to ask a person, what an agent may do, and when the
work is complete.

## Choose a starting point

- [Run your first workflow](./getting-started) to set up a factory.
- [Learn the core concepts](./concepts) to understand the files you will edit.
- [Explore the API](/api/) when you need exact functions and types.
