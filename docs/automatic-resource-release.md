# Automatic release lifecycle

This document records the lifecycle implemented for AGE-464. It amends the
deferred automatic-release decision in [ADR 0020](./adr/0020-blocks-recipes-and-run-resources.md)
without changing the release policy introduced by AGE-472.

## Trigger and discovery

The factory service owns automatic release. It watches active runs through the
World's `runs.waitForTerminalStatus` capability and reconciles the complete set
of terminal runs at startup and on a bounded polling interval. A notification
is therefore only a fast wake: a lost notification, a service restart between
terminal transition and cleanup, and a transient cleanup error are all found
by reconciliation. Suspended and otherwise non-terminal runs are never release
candidates.

A pull-request resource is observation data, not a cleanup trigger. A workflow
parked in the pull-request gate remains non-terminal and keeps its resources.
Cleanup begins only after the existing gate has observed either a merge or a
closed-without-merge result and the workflow itself reaches a terminal state.

## Policy and explicit calls

The service resolves policy in the existing order: workflow entry, factory
default, then `{ onSuccess: "release", onFailure: "keep" }`. `completed` maps
to `onSuccess`; both `failed` and `cancelled` map to `onFailure`. Cancellation
uses the failure policy because it is an interrupted execution and may retain
unfinished work.

The explicit `release(policy)` block records its selected success action before
applying it. A recorded explicit `keep` is authoritative for the remainder of
the run, so automatic release cannot silently reverse a per-call choice. An
explicit `release` and later automatic release share the same implementation
and are idempotent. The explicit block remains useful when a workflow wants its
release report before returning; automatic release is the safety net for
workflows that omit the call and for failure or cancellation policy.

## Persistent progress and reporting

Cleanup intent and progress use a fixed, bounded pair of reserved run
attributes. They do not consume one attribute per attempt or per resource.
The progress value records `pending`, `running`, `kept`, `complete`, or
`failed`, the terminal outcome, and compact counts. The existing worktree
registry remains the ownership authority for managed worktrees; there is no
second cleanup database.

An attempt is successful only after every eligible managed-local resource has
either been released or deliberately kept. A failed worktree remains in the
registry and its failure is recorded on the run, so the next reconciliation
can retry it without changing the workflow's terminal result. Resource
attributes are never erased by cleanup: released, kept, failed, and unknown
kinds stay visible in `jigs status <run-id>`. Unknown kinds are reported as unknown and
never dispatched to deletion code.

The progress marker is a checkpoint, not an exactly-once claim. On restart the
service retries `pending`, `running`, and `failed` attempts. It may also safely
revisit a completed attempt because the release implementation tolerates an
absent worktree, registry row, run directory, or branch. Duplicate terminal
signals and explicit-plus-automatic release therefore converge on the same
result.

## Synchronization and deletion safety

Terminal run status alone is insufficient because cancellation permits an
already-running step to finish. The cleanup module waits until the World shows
no pending or running steps, acquires a run-scoped PostgreSQL advisory lock
through the existing registry connection, and checks active steps again while
holding that lock. Worktree provisioning and explicit release take the same
lock from before they touch managed state until their operation is complete.
If a step is still active, automatic cleanup records no destructive progress
and retries later. This covers a worktree created or registered after
cancellation: the active step keeps cleanup out, and its registry row is found
on the next pass.

The lock remains held across Git safety inspection and deletion. This closes
the race in which another managed operation could change ownership or the
worktree between the check and removal. Git deletion keeps the existing
positive-evidence rules: dirty trees stay, a branch is deleted only when its
tip is proved contained by the fetched remote default branch, and an
unreachable remote, unresolved ref, changed ref, or failed push preserves the
branch. Automatic cleanup never pushes work to make it deletable.

On service shutdown the coordinator first stops timers and aborts terminal
waits, then drains every reconciliation or destructive attempt it already
admitted. This quiesce phase finishes before the World and registry-owning
service dependencies begin closing. A World implementation that ignores an
aborted terminal wait cannot hold shutdown open, and a late notification
cannot admit cleanup after shutdown starts.

Manual `jigs resources prune` remains the operator path for intentionally
reclaiming kept resources. It is preview-only until `--apply`, requires offline
service-and-child quiescence, and uses the same registry, run lock and Git
decision machinery as automatic and explicit release. Apply also requires a
record that the factory's last service start used the current systemd scope
supervisor; when that record is missing, start and stop the service once before
retrying. Dirty or unmerged work has no force bypass.
