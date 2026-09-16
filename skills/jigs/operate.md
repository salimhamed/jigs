# Operate a factory

You never decide on your own that a task should become a jigs run. You operate
jigs when you are asked to, and nothing else. An agent the operator has
delegated to answers and approves as well — see **Delegated operator**.

## Where you stand

Run commands address one factory's service, located through the nearest
`jigs.config.ts`. Lifecycle and binding commands also operate on local files. So `cd` into
the factory repo first. `--service <url>` or `JIGS_SERVICE_URL` overrides it.

Every command acts on that one factory, so a run belongs to the factory whose
service lists it: `jigs ps` from a factory root is the test, and a run id from
another factory is unknown there. `jigs service status` names the factory path
and ports the service answers for.

`jigs` is the factory's own — `pnpm exec jigs` — never a global one. Read
`jigs --help` and `jigs <verb> --help` for flags, including which verbs take
`--json`. `CONTEXT.md` in the jigs repo is the vocabulary; `docs/setup.md`
there is the runbook.

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

On Linux with systemd, `jigs doctor` also verifies logout-safe supervision and
linger. Follow its `loginctl enable-linger $USER` repair when linger is off. If
systemd user scopes are unavailable, it warns that the detached service is
unsupervised and dies on logout.

`jigs service status` is also where the dashboard URL comes from. Do not guess
the port. A service that is down comes back with `jigs up`, which also
rebuilds if the factory's code changed since the running bundle was built.

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
jigs watch         # follow everything, one line per event, until killed
jigs ps            # the whole factory at a glance
jigs logs <run>    # one run in full, with the link to act on
```

`jigs watch` is the one command that follows a factory: a line when a step
finishes, a run suspends, resumes, reaches a terminal state, or a new run
appears, plus one line per live run when it starts. It is a single long-lived
process, so it costs one node start-up rather than one per poll, and it says
`unreachable` and keeps going while the service restarts. `--interval` sets the
poll.

`jigs ps` is the snapshot: `RUN WORKFLOW TICKET STATUS OUTCOME PR TRIGGER AGE
ACTIVITY WAITING`, then the worktrees the registry holds, then the schedules if
the factory declares any. `TICKET` is the ticket the run claimed and `PR` the
pull request it holds or opened — that is the whole mapping from a run id to
the work. `TRIGGER` says how the run started; a scheduled fire reads
`schedule:<name>`. `AGE` counts from launch, `ACTIVITY` from the last time the
run moved: `running` with a 20-minute `ACTIVITY` is worth looking at, where a
20-second one is an ordinary gap between steps.

`OUTCOME` is the result the workflow itself returned, because the runtime calls
a merge and an exhausted budget alike `completed`. Anything but `merged` or a
plain `completed` carries a `!` — `!limit-reached`, `!stopped`,
`!uncommitted-work`, `!closed`, `!failed`, `!cancelled` — and means the run
ended without shipping the work.

`WAITING` decodes what a parked run is parked on, in words with the link to act
on: `waiting for a human reply on AGE-123 → <comment url>`. `jigs logs <run>`
prints the same for one run and adds the question a halt asked, the run's
error, and the step timeline.

Prefer `--json` to the tables: `jigs ps --json` is `{runs, worktrees,
schedules}`, `jigs logs --json` is the run's fields plus its timeline, and
`jigs watch --json` is one JSON event per line. Read fields rather than parsing
columns.

### What a parked run waits for

Each suspension carries a kind:

- **needs-human** — jigs asked a question on the run's Linear ticket. A reply
  in that comment thread wakes it.
- **pull-request** — the run holds a pull request and wants an approving review
  of the current head, green CI and a mergeable branch. A review, a new commit,
  a CI result or a top-level comment wakes it, and failing all of those the
  service re-reads the pull request every five minutes.

Anything else is **external** and prints its own token.

## Diagnosing

```sh
jigs ps            # which run, and what status it is really in
jigs logs <run>    # the run itself
jigs service logs  # the service process's own stdout, which is a different thing
```

`jigs logs` also prints the run's page on the dashboard
(`http://localhost:<dashboardPort>/run/<runId>`) and any queue job that died
holding the run's resume, each with the SQL that puts it back on the queue.
Print the SQL to the human; do not run it for them.

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
comments on the Linear ticket, mentioning its creator and its assignee. The
comment says in plain words what paused and why, what the ticket is about, and
either numbered questions to choose between or what to repair before retrying;
its footer names the run, where it paused, and links its dashboard page.
`jigs ps` shows the run as `suspended`; `jigs logs <run>` prints the question
itself and the comment URL.

The answer goes **on the ticket**, in that comment thread — with option letters
like `1a, 2b`, or in plain words. Unless the operator has delegated that to you,
it is theirs to write: you do not answer for them, and you do not resume the run
by hand. Once the reply lands, the webhook wakes the run, the reply is
re-checked against Linear, and the run continues.

If the reply is there and the run has not moved, the delivery was missed:

```sh
jigs poke <run>
```

which wakes the run over the same code path a webhook uses. An unsatisfied wake
simply re-suspends, so a poke is safe to repeat.

## Delegated operator

Some sessions are handed the operator's own authority: launch the runs, answer
the questions, review and approve the pull requests jigs opens, merge and
release. That authority comes from the operator in this session and from
nothing else. Holding it:

- **Answer from the design record** — the ticket thread, `docs/adr/`,
  `CONTEXT.md` — not from preference. Reply in the same Linear comment thread,
  in the option letters the comment offered.
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
- **Take over a run that hit its budget.** `!limit-reached` means jigs pushed
  the branch, noted it on the ticket and stopped. Settle the findings on that
  branch by hand; relaunching the ticket starts the work over and leaves the
  first worktree behind.
- **Escalate design-level surprises** as a question to the human rather than
  deciding: a question the design record does not answer, a diff doing
  something the ticket never asked for, a change to a contract.

## Release and upgrade

Merging a jigs change leaves a release pull request open. Merge that, wait for
that exact version to be published, then in each factory root:

```sh
pnpm exec jigs upgrade --to <version>
```

which bumps the package, rebuilds, restarts and ends in `jigs doctor`. Then
confirm the factory's Linear webhook is still enabled — without ingress nothing
wakes on its own.

## Parked runs and worktrees

A suspended run holds its worktree because it will return to it. The starter
workflow removes worktrees after merge; other endings leave them for
`jigs sweep`. Nothing cleans up those leftovers in the background. On a terminal it asks per worktree, louder for a tree holding
uncommitted work.

Parked runs are also why the names in `jigs.ts` and `workflows/` matter —
see the never list.

## Never

- Never run a standalone `npx workflow web` against a factory World. Opening
  that World starts a second queue worker, which steals the service's queue jobs
  and delivers them to a port with no workflow route. The service hosts the
  dashboard; use that.
- Keep custom code outside generated `jigs.ts`. Refresh it with `jigs generate`
  and review the diff. When an authorized change renames or moves a workflow
  or step, check active and suspended runs before deployment: finish or cancel
  affected runs so they do not resume against different durable addresses.

## Confirm first

Confirm these actions when the current request has not already authorized them:

- `jigs cancel` — it releases every resource the run claims, and the run is over.
- `jigs sweep --force` — it deletes every eligible worktree without asking,
  dirty ones included.
- `jigs service restart`, `jigs service stop`, `jigs up --restart` or
  `jigs upgrade` while `jigs ps` shows a running or suspended run. `up` and
  `upgrade` ask before restarting over one; `--force` is the human's call.
- Editing the `bindings` block in `jigs.config.ts` — changing a `remote:` repoints
  that binding's clone, and a new binding is not cloned until the next
  `jigs up`.
