# Troubleshooting

jigs usually prints what failed and how to fix it on the next line. Start there.
Check whether the service is alive and read its startup or runtime failures:

```sh
pnpm exec jigs service status
pnpm exec jigs service logs
```

Once the service is running, `pnpm exec jigs doctor` checks configured
dependencies, credentials and tools against it. That includes calling the probe
tool of each MCP server an agent in `requires.agents` declares, so an expired
or missing MCP token fails there before a run hits it. Doctor does not prove a
Pi server that uses OAuth; Pi checks that login when the agent starts.

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

## `jigs up` says runs are waiting on steps that no longer exist

A run that is waiting or running replays the steps it recorded, by
[identity](/guide/concepts#folders-the-build-creates). When the new build no
longer has one of them, because you renamed or moved a step or its file, `jigs up`
stops before starting the service and lists each run with the steps it is
missing. The running service is left as it was.

Either let those runs finish on the build they started on, then rebuild, or
cancel each with `pnpm exec jigs cancel <run-id>`. Then run `pnpm exec jigs up`
again.

## A library import does not resolve

Workflow and configuration code use these imports:

```ts
import { defineWorkflow, harnesses } from "@jigs-ai/jigs";
import { runAgent } from "#jigs/routines";
import { createRunDirectory } from "#jigs/steps";
```

`#jigs/steps` and `#jigs/routines` resolve through the `imports` map in
`package.json` that `jigs init` writes: types from the installed
`@jigs-ai/jigs`, code from `.jigs/`, which `jigs build` writes and the
scaffolded `vitest.config.ts` writes before tests. Custom
`"use step"` implementations may also import `@jigs-ai/jigs/steps` and its
`steps/*` modules. Those low-level implementations are not durable wrappers
and must not be called directly from workflow code. See the [API import map](/api/).

## Workflow code that uses `Intl` throws at runtime

Workflow code can pass its tests and then throw on `Intl` in a running factory.
Workflow bodies run on Node by default, but on QuickJS when the service runs
with `WORKFLOW_VM=quickjs`. QuickJS has no `Intl`, so `Intl.DateTimeFormat` and
`toLocaleString("en-US")` fail there, while tests run on Node and pass. Time-zone libraries read their zone data from `Intl`, so they
fail the same way.

Put date, time-zone and locale formatting in a step. Steps always run on Node,
and the runtime records their result for replay:

```ts
// workflows/my-flow/steps.ts
export async function formatLocalTime(at: string, timeZone: string) {
  "use step";
  return new Date(at).toLocaleString("en-US", { timeZone });
}
```

## A run is waiting

Run `pnpm exec jigs status <run>`. A waiting run is expected when it asked a
question or is following a pull request; the status says what it needs. A
question waits for a reply in the run's Linear agent session on the ticket,
not in the ticket's comments. Starting another run does not answer the first
one.

Once you have answered, the run notices on its next
[check](/guide/waiting-and-events). `pnpm exec jigs poke <run>` makes it
check now. A poke cannot stand in for the answer or approval itself.

If the pull request is approved but `jigs status <run>` shows `CI: none` and a
blocker saying no checks have reported, either CI has not started on that
commit yet or the repository has none. jigs never merges without CI: add a CI
workflow to the repository, or merge it yourself.

A run that shows `running` but whose `ACTIVITY` age keeps growing with no step
in flight may be stuck. `pnpm exec jigs status <run>` lists any dead queue job
and how to requeue it.

## A run fails because of files nobody made on purpose

You might see one of these:

- `Cannot publish <branch>: the worktree has uncommitted changes that no review approved`
- a ticket note saying the builder left uncommitted changes

The cause is usually your repository's tests or other checks, not the agent's
code.

jigs only publishes work that was reviewed. Before it pushes a branch, it checks
that the working folder holds nothing beyond the reviewed commit. Agents run
your tests, linters and builds to check their work, and those tools often leave
files behind: Python's `__pycache__/`, `.pytest_cache/`, coverage reports, build
output. If Git would see such a file as new, jigs sees it too, can't tell it from
real work, and stops rather than guess.

**The fix:** add those files to your repository's `.gitignore`. A good test: run
your checks in a fresh clone, then run `git status`. If it lists anything you
didn't write, ignore it. For a Python repository, that is usually:

```gitignore
__pycache__/
.pytest_cache/
```

Then start the run again.

## Watch an agent step while it runs

An agent step that runs in a worktree writes what the agent does to a stream
while it works: its text and reasoning, and each tool call and result. To watch
it, open the run in the dashboard the service hosts (`jigs service status`
prints its URL, on `dashboardPort`), go to the **Streams** tab and pick the
stream of the step. The stream updates every few seconds while the run is
active. Each attempt of a step starts with an `attempt-start` record naming the
attempt, the harness and the worktree. Questions to an agent without a
worktree, and Pi runs, write no stream.

The stream is stored in the factory's Postgres database with the run and never
expires. Tool output can include file contents, command output and secrets the
agent read, so treat the database as sensitive. Use only the service's
dashboard: `workflow web` run against the factory takes its queue jobs.

## An old worktree or directory is still there

That is often on purpose: failed runs, waiting runs and unfinished Git work
keep their resources. Every run works on its own branch and worktree, so a run
started again for the same ticket leaves the earlier one's behind.
`pnpm exec jigs status <run>` says why each one was kept. Inspect them with `pnpm exec jigs resources list`, then
preview `pnpm exec jigs resources prune` before you remove anything. See
[CLI commands](/guide/cli#cleaning-up-resources).

## A run's branch is still on GitHub

jigs never deletes remote branches. `pnpm exec jigs resources prune` lists the
branches finished runs left, each with the `git push origin --delete <branch>`
that removes it. GitHub's "automatically delete head branches" repository
setting deletes the branch when its pull request merges.

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

The service record names a process that is running, but jigs cannot confirm it
is the service it started. jigs signals nothing and does not start a second
service. The message says why:

- **Its start time or command differs from the service record.** Usually another
  program was given that process ID after the service exited.
- **The record is from an earlier boot, yet the process matches it.** This
  should not happen; treat the process as possibly the service.

Check the named process with `ps -p <pid> -o pid,command`. If it is not the
factory's service, delete the record the message names and run the command
again. If it is, stop it yourself (`kill <pid>`), check that nothing it started
is left, then delete the record.

## Starting the service says the URL is already served by another process

Another program already listens on the factory's `service.port`, so the new
service could not take the port. jigs stops the service it just started and
leaves the other process alone. The message names that process ID, or says the
answer carried none when the program is not a jigs service.

Find the program with `ps -p <pid> -o pid,command`, or with `lsof -i :<port>`
when no ID is named. Stop it if it should not be running, often a service
another factory or checkout started, then run `jigs up` again. To keep both,
give this factory another `service.port` in `jigs.config.ts`.

## A service command says the service record is unreadable

The service record under `~/.local/share/jigs/services/` is damaged. Check with
`ps -A -o pid,pgid,command` that nothing the factory's service started is
still running, end anything that is, then delete the file the message names.

## Runs stop moving after you ran `workflow web`

Never run the Workflow SDK's standalone `workflow web` against a factory's
database. It starts a queue worker that takes the factory's jobs. Stop it, and
use the dashboard the service hosts instead.
