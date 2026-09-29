# Cancelling a run stops its agents from inside the step

Status: accepted

`run.cancel()` only records `run_cancelled`; it does not interrupt code a step
is executing. So each agent invocation watches its own run: the step reads the
run's status before launching the harness, then waits on the World's
terminal-status signal for as long as the harness runs. On `cancelled` it stops
the harness's private process group and fails with a fatal error, because an
ordinary error leaves a pending retry that automatic release treats as a busy
run forever. Other terminal outcomes end the watch and change nothing.

- **Cancel acknowledges, it does not confirm.** `jigs cancel` returns once the
  cancellation is recorded; agents stop a few seconds later. Cancellation is
  recorded first, so a stop can never race a run that finished another way.
- **Every harness owns a process group**, including Codex, whose provider
  spawns its app server itself; jigs starts it under a small supervisor that
  owns the group.
- **The stop reaches drivers as a signal** on `DriverContext`, and
  `createAgentRunner` passes it on every call, so a factory's own agent step
  is covered too.
- **A stop is bounded.** SIGTERM, a short grace, SIGKILL, then a bounded check;
  a group that cannot be confirmed gone is logged and cleanup proceeds.

## Consequences

- A failed first status read throws an ordinary error, so the SDK retries the
  step rather than launch an agent for a run it cannot see.
- Out of scope: processes that leave the group, agents orphaned by a killed
  service, Windows process trees, and undoing work an agent already did.
- Rejected: an abort hook resumed before cancelling (needs a signal argument in
  every workflow and ordering against replay), and a service-side registry of
  live invocations so the CLI could wait for confirmed exit (startup races and
  a registry shared across bundles, for a small operator gain).
