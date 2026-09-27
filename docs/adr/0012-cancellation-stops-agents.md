# Cancelling a run stops its agents from inside the step

Status: accepted

`run.cancel()` only records `run_cancelled`; it does not interrupt code a step
is executing. So each agent invocation watches its own run: the step reads the
run's status before launching the harness, then waits on the World's
`runs.waitForTerminalStatus` (Postgres `NOTIFY` backed by a re-read at least
every second) for as long as the harness runs. On `cancelled` it aborts a local
signal, which stops the harness's private process group: SIGTERM, one second's
grace, SIGKILL, then a bounded check that the group is gone. The step then
fails with a fatal error, because an ordinary error leaves a pending retry that
automatic release treats as a busy run forever. Other terminal outcomes end the
watch and change nothing.

- **Cancel acknowledges, it does not confirm.** `jigs cancel` returns once the
  cancellation is recorded; agents stop a few seconds later. The route still
  records cancellation first, so a stop can never race a run that finished
  another way.
- **Every harness owns a process group.** Pi and Claude Code are spawned
  detached by jigs. The Codex provider spawns its app server itself and its
  close signals only that child, so the launcher execs a small Node supervisor
  that starts Codex in its own group and stops the group itself when it is
  signalled, when its parent goes, or when Codex exits. Cancellation closes the
  provider at once; the step still settles only once the provider gives up on
  the interrupted turn, about five seconds later.
- **`OpenContext.signal` and `DriverContext.signal` carry the stop** to drivers,
  and `createAgentRunner` models pass it on every call and turn any failure
  after the cancellation into the fatal error, so a factory's own step is
  covered too.
- **A stop is bounded and never trusted blindly.** A group still visible after
  SIGKILL can run no more code, so it is logged and cleanup proceeds. A signal
  that cannot be delivered is logged with the run and group, and the group
  stays registered for service shutdown. A once-a-second sweep retires any
  tracked Pi or Claude Code group that is gone, so a reused id is never
  signalled.
- A failed first status read throws an ordinary error, so the SDK retries the
  step rather than launch an agent for a run it cannot see.
- Out of scope: processes that leave the group, agents orphaned by a killed
  service, Windows process trees, and undoing work an agent already did.
- Rejected: an abort hook resumed before cancelling (needs a signal argument in
  every workflow and ordering against replay), and a service-side registry of
  live invocations so the CLI could wait for confirmed exit (startup races and
  a registry shared across bundles, for a small operator gain).
