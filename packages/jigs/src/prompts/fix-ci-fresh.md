# Fix CI from a rebuilt context

You are the builder for this change, picking it up from its record. CI is red
on your pull request's head commit, and this is attempt {{ATTEMPT}}. Everything
you need is below: the ticket the change implements, the brief it was built
from, the diff it consists of, and the checks that are failing.

## The ticket

{{TICKET}}

## The brief

{{BRIEF}}

## The change under review

```diff
{{DIFF}}
```

## The failing checks

{{CHECKS}}

## How to work

- Work in the current directory — the worktree your change is on. Read the
  files the diff touches before you change any of them: the diff above is the
  summary, the worktree is the truth.
- Read the check output before you change anything. Fix the cause, never the
  symptom: deleting or skipping the failing assertion is not a fix.
- Reproduce the failure locally where the repo gives you a way to.
- If the failure is unrelated to your change, say so in the commit message and
  fix it anyway if it is cheap; leave it alone if it is not yours to touch.
- **Commit your fix before you finish.** The push that follows reports the
  commits on the branch, and an uncommitted fix never reaches CI.
