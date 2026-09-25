# Troubleshooting

jigs usually prints what failed and how to fix it on the next line. Start there.
For service problems, these two commands give the most useful evidence:

```sh
pnpm exec jigs service status
pnpm exec jigs service logs
```

## The service exits before it is ready

Read `jigs service logs`. The usual causes:

- **Docker is not running**, so Postgres is not up.
- **A harness CLI is missing from the service's `PATH`.** The service checks
  the CLI of every harness your workflows require, and the log names the
  workflows that need it. Start `jigs up` from a shell where that CLI runs, or
  for Claude Code set `JIGS_CLAUDE_EXECUTABLE` in `.env`.
- **Codex or Pi is too old.** The log names the minimum version; upgrade the CLI.
- **A binding's remote cannot be reached.** The service clones every binding
  before it is ready, and exits with the Git error if it cannot.

Fix the cause and run `jigs up` again.

## A build says `jigs/` is out of date

Run `pnpm exec jigs generate`, review the change to `jigs/steps.ts` and
`jigs/routines.ts`, then run `pnpm exec jigs up`. Keep your own code out of
`jigs/`, since generating replaces it.

A build also refuses a factory that still has a `jigs.ts` from an earlier
release. Run `pnpm exec jigs upgrade`. It deletes `jigs.ts`, writes `jigs/`,
and replaces the older entries in the `imports` map in `package.json` with
`#jigs/*`. Then change your workflows to import from
`#jigs/steps` and `#jigs/routines` instead of `#jigs`.

## A library import does not resolve

`@jigs-ai/jigs` has one entry for workflow code: the root. Import descriptors,
types, schemas and renderers from `@jigs-ai/jigs`. Import routines such as
`claimTicket`, `agentSession` or `watchPullRequest` from `#jigs/routines`, after
`pnpm exec jigs generate`.

## A run is waiting

Run `pnpm exec jigs status <run>`. A waiting run is expected when it asked a
question or is following a pull request; the status says what it needs and
links to where you act. Starting another run does not answer the first one.

Once you have answered, the run notices on its next
[check](/guide/configuration#webhooks). `pnpm exec jigs poke <run>` makes it
check now. A poke cannot stand in for the answer or approval itself.

If the pull request is approved but `jigs status <run>` shows `CI: none` and a
blocker saying no checks have reported, either CI has not started on that
commit yet or the repository has none. jigs never merges without CI: add a CI
workflow to the repository, or merge it yourself.

If `jigs status` reports a run as `stalled`, nothing is going to move it; its
detail view shows the step or queue job that died and how to requeue it.

## Doctor reports webhook deliveries rejected with 401

GitHub's copy of the webhook secret does not match `GITHUB_WEBHOOK_SECRET` in
`.env`. Run `pnpm exec jigs bind <remote>` for that repository to send GitHub
the current secret.

## An old worktree or directory is still there

That is often on purpose: failed runs, waiting runs and unfinished Git work
keep their resources. Inspect them with `pnpm exec jigs resources list`, then
preview `pnpm exec jigs resources prune` before you remove anything. See
[CLI commands](/guide/cli#cleaning-up-resources).

## Runs stop moving after you ran `workflow web`

Never run the Workflow SDK's standalone `workflow web` against a factory's
database. It starts a queue worker that takes the factory's jobs. Stop it, and
use the dashboard the service hosts instead.
