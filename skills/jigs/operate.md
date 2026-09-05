# Operate a factory

You never decide on your own that a task should become a jigs run. You operate
jigs when you are asked to, and nothing else.

## Where you stand

Every operational verb is an HTTP client of one factory's service, and it finds
that service by reading the `jigs.yml` of the directory you are in. So `cd` into
the factory repo first. `--service <url>` or `JIGS_SERVICE_URL` overrides it.

Read `jigs --help` and `jigs <verb> --help` for flags. `CONTEXT.md` in the jigs
checkout is the vocabulary; `docs/setup.md` there is the runbook.

## First two commands, always

```sh
jigs service status   # is the service up, and on which ports
jigs doctor           # the check catalog, in the service's own environment
```

`jigs doctor` is an HTTP call into the service, not a local check — if the
service is down it cannot answer, and starting the service is the first repair.
Every failing check prints its own repair line; follow that rather than
improvising. `jigs service start` returns before the port is listening, so
"could not reach the jigs service" seconds after a start means booting, not
broken; re-run, and read `jigs service logs` if it persists.

`jigs service status` is also where the dashboard URL comes from. Do not guess
the port.

```
my-factory-2286ac2a: running pid 3343834 at http://localhost:9010
dashboard: http://localhost:9110
factory /home/you/my-factory
```

## Naming a run

`<run>` is a run id, a unique prefix of one, or the ticket the run claimed —
its Linear identifier (`AGE-123`) or its UUID. An ambiguous prefix lists the
candidates instead of guessing; pass a longer one.

## Watching

```sh
jigs ps
```

Runs first (`RUN PIPELINE STATUS TRIGGER AGE`), then the worktrees the registry
holds, then a schedule table if the factory declares any. `TRIGGER` says how
each run started; a scheduled fire reads `schedule:<name>`.

## Diagnosing

```sh
jigs ps            # which run, and what status it is really in
jigs logs <run>    # state, suspensions, milestone log, step timeline
jigs service logs  # the service process's own stdout, which is a different thing
```

`jigs logs` prints the run's page on the dashboard
(`http://localhost:<dashboard_port>/run/<runId>`), then the step timeline
(`STEP STATUS ATTEMPT STARTED TOOK ERROR`), then any queue job that died holding
the run's resume, each with the SQL that puts it back on the queue. Print the
SQL to the human; do not run it for them.

Statuses worth knowing:

- **suspended** — the run is parked on a satisfier and is fine. See below.
- **stalled** — the queue gave up on a job of this run's, holds no live one to
  replace it, and no step is in flight. Nothing is coming to move it. This is
  the status that means the run is genuinely stuck, and `jigs logs` names the
  dead job.
- **running** with no step in flight is an ordinary gap between steps, not a
  stall.

A run that is suspended is not stuck; a run that is stalled is.

## Needs-human halts

A step can raise a halt instead of proceeding. The run then suspends and jigs
posts the reason as a comment on the Linear ticket, mentioning the ticket's
creator. `jigs ps` shows the run as `suspended`; `jigs logs <run>` names the
suspension, its reason, and what satisfies it.

The human answers **on the ticket**, in that comment thread. You do not answer
for them, and you do not resume the run by hand. Once they reply, the webhook
wakes the run, the reply is re-checked against Linear, and the run continues.

If the reply is there and the run has not moved, the delivery was missed:

```sh
jigs poke <run>
```

which wakes the run over the same code path a webhook uses. An unsatisfied wake
simply re-suspends, so a poke is safe to repeat.

## Parked runs and worktrees

A suspended run holds its worktree, on purpose — it is coming back to it. Every
other ending leaves the tree on disk, where `jigs ps` shows it as `abandoned`.
`jigs sweep` is the only thing that ever removes one; nothing runs in the
background. On a terminal it asks per worktree, louder for a tree holding
uncommitted work.

Parked runs are also why the names in `steps/jigs.ts` and `pipelines/` matter —
see the never list.

## Never

- Never run a standalone `npx workflow web` against a factory World. Opening
  that World starts a second queue worker, which steals the service's queue jobs
  and delivers them to a port with no workflow route. The service hosts the
  dashboard; use that.
- Never rename, move, or delete an exported function in a factory's
  `steps/jigs.ts`, or a file under `pipelines/`, without the human's explicit
  instruction. Those names are the memoization keys of every parked run, and the
  build stays green while they are orphaned.

## Confirm first

Ask the human before:

- `jigs cancel` — it releases every resource the run claims, and the run is over.
- `jigs sweep --force` — it deletes every eligible worktree without asking,
  dirty ones included.
- `jigs service restart` or `jigs service stop` while `jigs ps` shows a running
  or suspended run.
- Editing the `bindings` block in `jigs.yml`.
