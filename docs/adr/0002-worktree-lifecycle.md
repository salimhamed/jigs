# Centrally housed worktrees, evidence-based teardown

Status: accepted

Worktrees are cut from jigs' own bare clone of a binding's remote, at
`jigsDataDir()/bindings/<factory-slug>/<binding>/{repo.git,worktrees/<branch>}`,
never beside a human's checkout. The factory slug (directory name plus a short
path hash) keeps two factories' same-named bindings apart.

- **Clones are made when the service starts**, one per declared binding. A
  worktree request for a binding with no clone is refused, so a binding added
  while the service runs needs a restart. The clone is four idempotent steps
  (`init --bare`, point `origin`, `fetch`, `remote set-head --auto`) and
  `refs/remotes/origin/HEAD` marks it finished, so an interrupted clone resumes.
- **Freshness is `git fetch`.** New branches fork from `origin/<default>`. An
  existing local branch is checked out as-is and never reset; a remote-only
  branch is tracked. Every git call passes an explicit `cwd`, because removing
  a worktree deletes the working directory of whoever runs it.
- **Reuse is refused, not repaired.** A worktree owned by another live or
  suspended run is a hard error naming the owner. An unowned worktree that is
  dirty, diverged from its remote branch or on another branch is preserved
  untouched and the request fails with guidance. The owner's own re-entry
  reuses its worktree as-is.
- **Provisioning fails fast.** `copy` globs match dotfiles, never overwrite,
  and fail the request when a pattern matches nothing or leaves
  `bindings/<name>/`. `postCreate` runs with `VIRTUAL_ENV` removed and stdin
  closed under `hookTimeoutMinutes` (default 10); a failing hook fails the
  request and leaves the tree marked `provision-failed` for diagnosis.

## Teardown

Teardown is runtime-owned and runs only for terminal runs
([0008](./0008-blocks-recipes-and-run-resources.md) says when). It decides from
two facts per worktree: whether the tree is dirty, and how many commits the
branch holds that the freshly fetched `origin/<default>` lacks.

| Facts | Action |
| --- | --- |
| dirty | keep the worktree and branches; mark it `abandoned-dirty` |
| clean, 0 unmerged commits | force-remove the worktree; delete the local and remote branch |
| clean, unmerged commits or no answer | remove the worktree; keep every branch |

A failed fetch, an unresolvable default branch or a remote `HEAD` that does not
match the fetched ref counts as no answer. Before deleting, each branch ref is
pinned to its current sha and rechecked, and the remote branch is deleted with
`--force-with-lease`, so a branch that moved in the meantime survives. A
`provision-failed` worktree is always kept.

## Consequences

- Deleting a branch needs positive evidence. There is no force flag, no
  automatic WIP commit and no deletion of unmerged work.
- A squash-merged branch is not contained in the default branch, so its
  branches are kept; `jigs resources prune` reclaims them.
- `abandoned-dirty` and kept resources are visible in `jigs status` and
  `jigs resources list`.
- The copy globber must keep matching dotfiles, or `.env`-class copies vanish.
