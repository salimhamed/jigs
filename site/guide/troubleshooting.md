# Troubleshooting

jigs usually prints what failed and how to fix it on the next line. Start there.
Check whether the service is alive and read its startup or runtime failures:

```sh
pnpm exec jigs service status
pnpm exec jigs service logs
```

Once the service is running, `pnpm exec jigs doctor` checks configured
dependencies, credentials and tools against it.

## The service exits before it is ready

Read `jigs service logs`. The usual causes:

- **Docker is not running**, so Postgres is not up.
- **A harness CLI is missing from the service's `PATH`.** The service checks
  the CLI of every harness your workflows require, and the log names the
  workflows that need it. Start `jigs up` from a shell where that CLI runs, or
  for Claude Code set `JIGS_CLAUDE_EXECUTABLE` in `.env`.
- **Codex or Pi is too old.** The log names the minimum version; upgrade the CLI.
- **A binding's remote cannot be reached.** The service clones every binding
  into `~/.local/share/jigs/clones/` before it is ready, and exits with the Git
  error if it cannot.

Fix the cause and run `jigs up` again. Harness installation and authentication
are covered in [Models and harnesses](/guide/models-and-harnesses).

## A build says `jigs/` is out of date

Run `pnpm exec jigs generate`, review the change to `jigs/steps.ts` and
`jigs/routines.ts`, then run `pnpm exec jigs up`. This is generated code committed
to the factory to keep [step identities stable](/guide/concepts#why-jigs-generates-code-in-your-factory).
Keep your own code outside `jigs/`, since regeneration replaces it.

A build also refuses a factory that still has a `jigs.ts` from an earlier
release. Run `pnpm exec jigs upgrade`. It deletes `jigs.ts`, writes `jigs/`,
and replaces the older entries in the `imports` map in `package.json` with
`#jigs/*`. Then change your workflows to import from
`#jigs/steps` and `#jigs/routines` instead of `#jigs`.

## A library import does not resolve

Workflow and configuration code use these imports:

```ts
import { defineWorkflow, harnesses } from "@jigs-ai/jigs";
import { runAgent } from "#jigs/routines";
import { createRunDirectory } from "#jigs/steps";
```

Run `pnpm exec jigs generate` if the generated imports are missing. Custom
`"use step"` implementations may also import `@jigs-ai/jigs/steps` and its
`steps/*` modules. Those low-level implementations are not durable wrappers
and must not be called directly from workflow code. See the [API import map](/api/).

## A run is waiting

Run `pnpm exec jigs status <run>`. A waiting run is expected when it asked a
question or is following a pull request; the status says what it needs and
links to where you act. Starting another run does not answer the first one.

Once you have answered, the run notices on its next
[check](/guide/waiting-and-events). `pnpm exec jigs poke <run>` makes it
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
keep their resources. `pnpm exec jigs status <run>` says why each one was kept.
Inspect them with `pnpm exec jigs resources list`, then
preview `pnpm exec jigs resources prune` before you remove anything. See
[CLI commands](/guide/cli#cleaning-up-resources).

`pnpm exec jigs resources prune --apply` refuses while the service or anything
it started is still running, on macOS and Linux alike. Run
`pnpm exec jigs service stop`, then apply again.

## `jigs service stop` says processes are still running

The stop ended everything it could and lists each process that survived, with
its process ID and command. That is usually a process the stopping user may not
signal, such as one started with `sudo`. End each listed process yourself, then
run the command again. See
[Stopping the service](/guide/cli#stopping-the-service).

## A service command says a process ID cannot be verified as the service

The pidfile names a process that is running, but jigs cannot confirm it is the
service it started. jigs signals nothing and does not start a second service.
The message says why:

- **Its start time or command differs from the service record.** Usually another
  program was given that process ID after the service exited.
- **There is no service record.** The record was deleted while the pidfile was
  left behind.
- **The record is from an earlier boot, yet the process matches it.** This
  should not happen; treat the process as possibly the service.

Check the named process with `ps -p <pid> -o pid,command`. If it is not the
factory's service, delete the two files the message names and run the command
again. If it is, stop it yourself (`kill <pid>`), check that nothing it started
is left, then delete the two files.

## A service command says the service record is unreadable

The service record under `~/.local/share/jigs/services/` is damaged. Check with
`ps -A -o pid,pgid,command` that nothing the factory's service started is
still running, end anything that is, then delete the file the message names.

## A service command says the pidfile and the service record name different processes

The two files disagree about which process is the service, so jigs trusts
neither. Check both process IDs with `ps -p <pid> -o pid,command`, stop the one
that is the factory's service if either is, then delete both files the message
names.

## Runs stop moving after you ran `workflow web`

Never run the Workflow SDK's standalone `workflow web` against a factory's
database. It starts a queue worker that takes the factory's jobs. Stop it, and
use the dashboard the service hosts instead.
