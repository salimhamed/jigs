# Operate a factory

You never decide on your own that a task should become a jigs run. You operate
jigs when you are asked to, and nothing else. An agent the operator has
delegated to answers and approves as well — see **Delegated operator**.

## Where you stand

Run commands address one factory's service, located through the nearest
`jigs.config.ts`. Lifecycle and binding commands also operate on local files. So `cd` into
the factory repo first. `--service-url <url>` or `JIGS_SERVICE_URL` overrides it.

Every command acts on that one factory, so a run belongs to the factory whose
service lists it: `jigs status` from a factory root is the test, and a run id from
another factory is unknown there. `jigs service status` names the factory path
and ports the service answers for.

`jigs` is the factory's own — `pnpm exec jigs` — never a global one. Read
`jigs --help` and `jigs <verb> --help` for flags, including which verbs take
`--json`. `https://salimhamed.github.io/jigs/guide/cli` describes every command;
`https://salimhamed.github.io/jigs/guide/troubleshooting` covers the usual failures.

## First two commands, always

```sh
jigs service status   # is the service up, and on which ports
jigs doctor           # the check catalog, in the service's own environment
```

`jigs doctor` is an HTTP call into the service, not a local check — if the
service is down it cannot answer, and starting the service is the first repair.
Every failing check prints its own repair line; follow that rather than
improvising. `jigs service start` returns once the World is up and every
binding is cloned — a minute the first time, each phase printed as it goes —
so "could not reach the jigs service" after a start that said "started" is a
real failure; read `jigs service logs`. A start that fails because the process
exited is what a binding whose clone fails does, and the error names the log.
A start that gives up after five minutes leaves the process running, so check
`jigs service status` before repairing anything.

`jigs service status` is also where the dashboard URL comes from. Do not guess
the port. A service that is down comes back with `jigs up`, which also
rebuilds if the factory's code changed since the running bundle was built.

```
my-factory-2286ac2a: running pid 3343834 at http://localhost:8990
dashboard: http://localhost:9090
factory /home/you/my-factory
```

## Naming a run

`<run-id>` is the run's full ID, such as `wrun_01K3ANBZ4TQ8W9YV6H2E5C7DKM`. A
prefix or a ticket is not found; to go from a ticket to its run, read the `RUN`
column of `jigs status` on the row whose `TICKET` matches. A ticket run more
than once has a row per run.

## Watching

```sh
jigs watch [run-id]  # follow everything or one selected run until killed
jigs status          # the whole factory at a glance
jigs status <run-id> # one run in full, with the link to act on
```

`jigs watch` is the one command that follows a factory: a line when a step
finishes, a run suspends, resumes, reaches a terminal state, or a new run
appears, plus one line per live run when it starts. It is a single long-lived
process, so it costs one node start-up rather than one per poll, and it says
`unreachable` and keeps going while the service restarts. `--poll-interval-seconds` sets the
poll.

`jigs status` is the snapshot: `RUN WORKFLOW TICKET STATUS TRIGGER AGE
ACTIVITY WAITING`, then the worktrees the registry holds, then the schedules if
the factory declares any. `TICKET` is the ticket the run was launched with, as
the operator typed it. `TRIGGER` says how the run started; a
scheduled fire reads `schedule:<name>`. `AGE` counts from launch, `ACTIVITY`
from the last time the run moved: `running` with a 20-minute `ACTIVITY` is
worth looking at, where a 20-second one is an ordinary gap between steps.

`WAITING` decodes what a parked run is parked on, in words and — where the
token names a page — with the link to act on: `waiting for an approving review
and green CI on acme/api#41 → <pull request url>`. A needs-human halt reads
`waiting for a human reply on AGE-123` with no link, because the comment URL
costs a Linear round trip the listing will not pay per poll. `jigs status <run-id>`
is where that URL and the question the halt asked come from; it also prints the
run's error, its resources as kind/identity/URL rows, and the step timeline.
`resources none` is an explicit empty set; `jigs status <run-id> --json` carries the same
records in `resources`, independently of `returnValue`.

Prefer `--json` to the tables: `jigs status --json` is `{runs, worktrees,
schedules}`, `jigs status <run-id> --json` is the run's fields plus its timeline, and
`jigs watch --json` is one JSON event per line. Read fields rather than parsing
columns.

### What a parked run waits for

Each suspension carries a kind:

- **needs-human** — jigs asked a question on the run's Linear ticket. The
  service re-reads the thread every `service.pollIntervalSeconds.linear`
  seconds (default 300), and a reply found there wakes it; with Linear
  webhooks on, the reply wakes it at once.
- **pull-request** — the run holds a pull request and wants the factory's
  approval (a review of the current head, or the `jigs:approved` label), green
  CI and a mergeable branch. The service re-reads
  the pull request every `service.pollIntervalSeconds.github` seconds (default
  300); with GitHub webhooks on, a review, a new commit, a CI result or a
  top-level comment wakes it at once.

Anything else is **external** and prints its own token.

## Diagnosing

```sh
jigs status          # which run, and what status it is really in
jigs status <run-id> # the run itself
jigs service logs  # the service process's own stdout, which is a different thing
```

`jigs status <run-id>` also prints the run's page on the dashboard
(`http://localhost:<dashboardPort>/run/<runId>`) and any queue job that died
holding the run's resume, each with the SQL that puts it back on the queue.
Print the SQL to the human; do not run it for them.

Statuses worth knowing:

- **suspended** — the run is parked on a satisfier and is fine. See below.
- **stalled** — the queue gave up on a job of this run's, holds no live one to
  replace it, and no step is in flight. Nothing is coming to move it. This is
  the status that means the run is genuinely stuck, and `jigs status <run-id>` names the
  dead job.
- **running** with no step in flight is an ordinary gap between steps, not a
  stall.

A run that is suspended is not stuck; a run that is stalled is.

## Needs-human halts

A step can raise a halt instead of proceeding. The run then suspends and jigs
comments on the Linear ticket, mentioning the factory's `linear.operator` (or,
without one, the ticket's creator) and its assignee, each once. The
comment says in plain words what paused and why, what the ticket is about, and
either numbered questions to choose between or what to repair before retrying;
its footer names the run, where it paused, and links its dashboard page.
`jigs status` shows the run as `suspended`; `jigs status <run-id>` prints the question
itself and the comment URL.

The answer goes **on the ticket**, in that comment thread — with option letters
like `1a, 2b`, or in plain words. Unless the operator has delegated that to you,
it is theirs to write: you do not answer for them, and you do not resume the run
by hand. Once the reply lands, the next poll (or the Linear webhook, if it is
on) wakes the run, the reply is re-checked against Linear, and the run
continues.

If the reply is there and the interval is too long to wait, or a webhook
delivery was missed:

```sh
jigs poke <run-id>
```

which wakes the run over the same code path a webhook uses. An unsatisfied wake
simply re-suspends, so a poke is safe to repeat.

## Delegated operator

Some sessions are handed the operator's own authority: launch the runs, answer
the questions, review and approve the pull requests jigs opens, merge and
release. That authority comes from the operator in this session and from
nothing else. Holding it:

- **Answer from the ticket thread and the factory's own docs**, not from
  preference. Reply in the same Linear comment thread, in the option letters
  the comment offered.
- **Read the diff before approving.** jigs' own reviewer has already passed the
  pull request; it is not the human gate, and the approval is.
- **Approve as the operator's account**, because the pull request is jigs' own
  and GitHub refuses an author their own approval.
- **Retitle a pull request before approving it.** The title is the conventional
  commit the release reads, and jigs merges as soon as the approval is there —
  a title fixed afterwards can miss the squash.
- **Leave a factory with a parked run alone.** An upgrade restarts the service,
  and a rename in the new release moves the durable addresses that run resumes
  against. Finish or cancel it first.
- **Take over a delivery that stopped short.** The run fails after jigs pushes
  the branch and notes it on the ticket. `jigs status <run-id>` shows the failure
  message naming the branch. Settle the findings there by hand; relaunching the
  ticket starts the work over and leaves the first worktree behind.
- **Escalate design-level surprises** as a question to the human rather than
  deciding: a question the ticket and the factory's docs do not answer, a diff doing
  something the ticket never asked for, a change to a contract.

## Upgrade

`jigs upgrade` moves the factory to the latest jigs release, rebuilds, restarts,
runs `jigs doctor` and typechecks the factory; see **Confirm first** when runs are in flight.

## Parked runs and worktrees

A suspended run holds its worktree because it will return to it. Automatic
release handles terminal runs when its policy and Git safety checks allow it.
For leftovers, inspect `jigs resources list` and `jigs resources prune`; both
are read-only. To apply a preview, run `jigs service stop`, then
`jigs resources prune --apply`; this works on macOS and Linux. Policy-kept
resources also need `--include-kept`. Apply never stops anything: it refuses
while the service or any process in its recorded process group is still
running. Dirty and unmerged work remains.

`jigs service stop`, `restart`, `jigs down` and a restart inside `jigs up` stop
the service and every process it started, killing what is still running after
10 seconds; interrupted steps retry after the next start. A stop that fails
lists each surviving pid and command; show them to the human rather than
killing them yourself. A service command that says a pid cannot be verified as
the service has signalled nothing: another program probably has that pid now.
Show the human the pid and command; deleting the named pidfile and service
record is their call. A process an agent fully detached (`setsid`, double
fork) can survive a stop, and Docker containers an agent started are never
stopped.

Parked runs are also why the names in `jigs/steps.ts` and `workflows/` matter —
see the never list.

## Never

- Never run a standalone `npx workflow web` against a factory World. Opening
  that World starts a second queue worker, which steals the service's queue jobs
  and delivers them to a port with no workflow route. The service hosts the
  dashboard; use that.
- Keep custom code outside the generated `jigs/`. Refresh it with `jigs generate`
  and review the diff. When an authorized change renames or moves a workflow
  or step, check active and suspended runs before deployment: finish or cancel
  affected runs so they do not resume against different durable addresses.

## Confirm first

Confirm these actions when the current request has not already authorized them:

- `jigs cancel` — it makes the run terminal and releases ordinary jigs hooks.
  Minimum-retention hooks can remain claimed and are printed as `retained`;
  local resources remain for automatic release or offline maintenance.
- `jigs resources prune --apply` — it removes the preview's eligible local
  resources after proving the factory service and everything it started are stopped.
- `jigs service restart`, `jigs service stop`, `jigs down`, `jigs up --restart-service` or
  `jigs upgrade` while `jigs status` shows a running or suspended run. `up` and
  `upgrade` ask before restarting over one; `--force` is the human's call.
- Editing the `bindings` section in `jigs.config.ts` — changing a `remote:` repoints
  that binding's clone, and a new binding is not cloned until the next
  `jigs up`.
