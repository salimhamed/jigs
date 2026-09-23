# Preflight in the trigger path, JIT checks as the backstop

Status: accepted

Before a run exists, the service's trigger path checks the run's requirements
and refuses to call `start()` on any failure. The list is computed from the
workflow's `requires` manifest, never hand-maintained:

- `integrations`: the Linear and GitHub credentials, only for the providers
  listed;
- `bindings`: the binding is declared, jigs' clone exists and the remote
  answers (the run's `binding` input narrows this to one);
- `harnesses` and `models`: each driver's installation and login checks;
- `aws`: `aws sts get-caller-identity` under the service's `AWS_PROFILE`.

Checks run in the service process, the environment steps actually run in, not
the CLI's shell. They are heuristic (no model calls), run concurrently and fail
together: every failure is reported at once with a repair line, and no run is
created. There is no skip flag.

## Consequences

- One **check catalog** serves three callers: trigger preflight, JIT checks
  inside steps, and `jigs doctor`. Doctor checks only what the factory's
  workflows require or its configuration enables, so a factory with no
  harness in use needs no harness CLI or login.
- **A JIT failure halts for a human, not the run.** `runAgentOrHalt` posts the
  repair lines to the ticket, suspends keeping the worktree, and re-runs the
  step from zero after a reply. Late discovery costs a pause, not a relaunch.
- **MCP servers are checked JIT only.** A step's `mcpServers` are built inside
  the workflow body, so they are not visible before it runs; a second manifest
  field would drift.
- **Nothing is rechecked on wake.** The resume path stays lean; staleness after
  days parked is the JIT checks' job, with the same repair text.
- Moving checks to the CLI or into a workflow's first step would be a
  regression: the CLI's environment differs from the service's, and a failed
  first step leaves a failed run as debris.
