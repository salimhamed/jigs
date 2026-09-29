# Centrally housed worktrees, evidence-based teardown

Status: accepted

Worktrees are cut from jigs' own bare clone of a binding's remote, kept under
jigs' data directory per factory, never beside a human's checkout. Clones are
made when the service starts, one per declared binding, so a binding added
while the service runs needs a restart.

- **Every run gets its own branch**: the requested name plus a suffix from the
  run ID, cut fresh from `origin/<default>`. A step retry lands on the same
  branch and path; no other run ever does. A run never adopts another run's
  worktree or branch, so there is no ownership check, handoff or reuse test. A
  branch is never reset, and a path holding anything unexpected is refused
  untouched.
- **Provisioning fails fast.** A `copy` pattern that matches nothing, or a
  failing `postCreate` hook, fails the request and keeps the tree for
  diagnosis.

## Teardown

Teardown is the worktree kind's release
([0007](./0007-routines-recipes-and-run-resources.md) says when). It decides from
two facts: whether the tree is dirty, and how many commits the branch holds
that the freshly fetched `origin/<default>` lacks.

| Facts | Action |
| --- | --- |
| dirty | keep the worktree and branch; the record is `kept` |
| clean, 0 unmerged commits | remove the worktree; delete the local branch |
| clean, unmerged commits or no answer | remove the worktree; keep the local branch |

Any doubt about the remote counts as no answer. jigs never deletes the pushed
branch on the remote; `jigs resources prune` lists the ones finished runs left
on GitHub, and GitHub's "automatically delete head branches" setting handles
merged pull requests.

## Consequences

- Relaunching a ticket starts over on a new branch and opens a new pull
  request. Picking up a stopped run's work is a person's job.
- Deleting a local branch needs positive evidence. There is no force flag, no
  automatic WIP commit and no deletion of unmerged work, so branches with
  unmerged work accumulate, one per run; `jigs resources` lists them.
- A squash-merged local branch is not contained in the default branch, so it
  stays in the clone.
