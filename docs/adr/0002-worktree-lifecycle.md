# Centrally housed worktrees, evidence-based teardown

Status: accepted

Worktrees are cut from jigs' own bare clone of a binding's remote, at
`jigsDataDir()/clones/<factory-slug>/<binding>/{repo.git,worktrees/<branch>}`,
never beside a human's checkout. The factory slug (directory name plus a short
path hash) keeps two factories' same-named bindings apart.

- **Clones are made when the service starts**, one per declared binding. A
  worktree request for a binding with no clone is refused, so a binding added
  while the service runs needs a restart. The clone is four idempotent steps
  (`init --bare`, point `origin`, `fetch`, `remote set-head --auto`) and
  `refs/remotes/origin/HEAD` marks it finished, so an interrupted clone resumes.
- **Every run gets its own branch.** The branch is the requested name plus
  `-` and the last six characters of the run ID, lowercased, so a step retry
  lands on the same branch and path and no other run does. It is always cut
  fresh from `origin/<default>` after a `git fetch` of the default branch; no
  other branch is fetched. A run never adopts another run's worktree or branch,
  so there is no ownership check, handoff or reuse test. Only the run's own
  retry finds its worktree at the path on its branch and takes it as-is. A
  branch is never reset: one left without a worktree is checked out as-is, so
  work on it survives, and a path holding anything else is refused untouched.
  Every git call passes an explicit `cwd`,
  because removing a worktree deletes the working directory of whoever runs it.
- **Provisioning fails fast.** `copy` globs match dotfiles, never overwrite,
  and fail the request when a pattern matches nothing or leaves
  `bindings/<name>/`. `postCreate` runs with `VIRTUAL_ENV` removed and stdin
  closed under `hookTimeoutMinutes` (default 10); a failing hook fails the
  request and leaves the tree's resource record `kept` for diagnosis.

## Teardown

Teardown is the worktree kind's release
([0008](./0008-blocks-recipes-and-run-resources.md) says when). It decides from
two facts: whether the tree is dirty, and how many commits the branch holds
that the freshly fetched `origin/<default>` lacks.

| Facts | Action |
| --- | --- |
| dirty | keep the worktree and branch; the record is `kept` |
| clean, 0 unmerged commits | force-remove the worktree; delete the local branch |
| clean, unmerged commits or no answer | remove the worktree; keep the local branch |

A failed fetch, an unresolvable default branch or a remote `HEAD` that does not
match the fetched ref counts as no answer. Before deleting, the local branch
ref is pinned to its current sha and rechecked, so a branch that moved in the
meantime survives.

jigs never deletes the pushed branch on the remote. It is recorded as a
`branch` resource, and `jigs resources prune` lists the ones finished runs left
on GitHub with the command that deletes them; GitHub's "automatically delete
head branches" setting handles merged pull requests.

## Consequences

- Relaunching a ticket starts over on a new branch and opens a new pull
  request; an older pull request stays open until someone closes it. Picking up
  a stopped run's work is a person's job.
- Branches with unmerged work accumulate, one per run, in the clone and on
  GitHub; `jigs resources` lists them.
- Deleting a local branch needs positive evidence. There is no force flag, no
  automatic WIP commit and no deletion of unmerged work.
- A squash-merged local branch is not contained in the default branch, so it
  stays in the clone.
- Kept resources and their reasons are visible in `jigs status` and
  `jigs resources list`.
- The copy globber must keep matching dotfiles, or `.env`-class copies vanish.
