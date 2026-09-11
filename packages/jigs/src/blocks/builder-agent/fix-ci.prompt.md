# Fix CI

CI is red on your pull request's head commit. This is attempt <%= it.ATTEMPT %>.

## The failing checks

<%= it.CHECKS %>

## How to work

- Work in the current directory — the worktree your change is on.
- Read the check output before you change anything. Fix the cause, never the
  symptom: deleting or skipping the failing assertion is not a fix.
- Reproduce the failure locally where the repo gives you a way to.
- If the failure is unrelated to your change, say so in the commit message and
  fix it anyway if it is cheap; leave it alone if it is not yours to touch.
- **Commit your fix before you finish.** The push that follows reports the
  commits on the branch, and an uncommitted fix never reaches CI.
