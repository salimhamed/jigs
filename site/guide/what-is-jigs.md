# What is jigs?

jigs runs durable TypeScript workflows for coding agents. A workflow is a
function that strings together agent runs, model calls, questions for a person,
and operations such as preparing a Git worktree or opening a pull request. You
write it once and run it as often as you like, so the same process happens the
same way each time.

Your workflows live in a **factory repo**, a repository of your own that
installs jigs as a package. The factory runs its own service on your machine,
with its own Postgres database and a dashboard of every run. When a run waits
for a reply, a review or a CI build, it keeps the work it has already done and
continues once the wait is over, even across a restart.

## What you get

- **Several GitHub repositories per factory.** Each target repository is a
  named **binding**. jigs keeps its own clone of it and gives every run a
  separate worktree, so runs never share a working directory.
- **Linear tickets and human questions.** A workflow can claim a Linear
  ticket, post a question on it, and pause until someone replies.
- **Optional webhooks.** Waiting runs re-check GitHub and Linear on a timer.
  Turn on webhooks only if you want them to react in seconds instead of minutes.
- **Durable workflows built on the Vercel Workflow SDK.** Completed steps are
  recorded, so a run that pauses or restarts does not repeat them.
- **Claude Code, Codex and Pi harnesses.** Run any of them as an agent in a
  worktree, or call a model API directly.
- **Your existing subscriptions.** Claude Code and Codex run under the accounts
  you are logged in to, so agent work bills your Claude and Codex plans.
