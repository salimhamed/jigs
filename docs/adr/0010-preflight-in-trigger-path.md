# Preflight in the trigger path, JIT as the backstop

Before a run exists, the service's trigger path verifies the run's
requirements and refuses to call `start()` on any failure. The check list is
computed, not hand-maintained: the workflow's `requires: { bindings,
harnesses, aws }` manifest (per binding — the name is declared, jigs' own
clone of its remote exists, concurrent `git ls-remote` auth probe; per harness
— the subscription login asserted via `claude auth status --json` requiring
`authMethod == "claude.ai"`, and the managed Codex home's `auth.json`
requiring `auth_mode == "chatgpt"`, deliberately not gating on Codex's
stale-while-valid JWT expiry; `aws` — `aws sts get-caller-identity` under the
service's `AWS_PROFILE`) united with a fixed core set every run needs: jigs'
two service credentials, `LINEAR_API_KEY` and `GITHUB_TOKEN`, read from the
factory repo's own `.env` that `jigs service start` loads, checked with a
viewer query and a whoami call. Checks run concurrently in the service
process — the
environment steps actually execute in, which the CLI's shell is not — are
heuristic (no model calls burned), and fail aggregated: every failure
reported at once, each line carrying a repair instruction, no run created, no
skip flag. Decided in
[AGE-294](https://linear.app/salboogie/issue/AGE-294/preflight-design).

## Consequences

- Checks and repair text live in one shared **check catalog** used by three
  callers: trigger-path preflight, JIT checks inside steps, and
  `jigs doctor` (the same engine behind a service endpoint + CLI verb,
  runnable without a launch).
- **MCP servers are deliberately not preflighted.** A step's `mcpServers`
  config is constructed inside the workflow body, so the list is not visible
  before the body executes; the only launch-time source would be a second,
  hand-maintained manifest field — the drift trap. MCP checks are JIT-only:
  the step hydrates exactly its declared servers and fails through the
  catalog if one won't start, connect, or auth.
- **A JIT check failure raises the needs-human halt, not a terminal
  failure**: the repair instruction is posted to the ticket via the claim
  channel, the run suspends keeping its worktree, and the step re-runs from
  zero after the human replies. Late discovery costs a pause, never a
  relaunch. (The general failure/retry taxonomy remains open; this pins the
  credential-failure case.)
- **No preflight re-runs on wake.** The ingress stays stateless and dumb;
  staleness after idle days is JIT's job, which is why the shared catalog —
  same repair text at launch and at step 6 on day 5 — matters.
- *Amendment (2026-09-22)*: "managed Codex home" is now an invocation home —
  private, temporary configuration per invocation — plus a durable per-run
  session store.

## Considered options

- **First step of every workflow**: a failure creates a failed run as
  debris, and memoized replay means it never re-runs on resume anyway.
- **CLI-side checks**: the interactive shell's env is not the service's env
  (an exported `ANTHROPIC_API_KEY` flips Claude's auth mode in one and not the
  other), and it breaks the day the CLI and service hosts diverge.
- **Proof-strength harness checks** (a real model call per launch): taxes
  every run to catch the rare server-side revocation JIT catches anyway.
- **Wake-path rechecks**: bloats the resume hot path and has no terminal to
  report to.
- **A `--skip-preflight` escape hatch**: every check guards something a run
  genuinely needs; a wrong block is a bug to fix. Add the flag the first
  time reality produces a false positive.
