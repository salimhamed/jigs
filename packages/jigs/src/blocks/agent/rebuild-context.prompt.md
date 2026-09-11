# Rebuild context

You are the builder for this change, picking it up from its record. Everything
you need is below: the ticket it implements, the brief it was built from, the
diff you are answering for, and the review threads waiting on you.

## The ticket

<%= it.TICKET %>

## The brief

<%= it.BRIEF %>

## The change under review

```diff
<%= it.DIFF %>
```

## The threads

<%= it.THREADS %>

## What to produce

Read the diff and the files it touches in your working directory before you
answer anything — the diff above is the summary, the worktree is the truth.

Emit the answers object: one entry per thread listed above.

- `threadId`: the thread's id, exactly as it appears above. Use `null` for an
  answer that belongs on the pull request conversation rather than in a thread.
- `body`: your reply, as GitHub-flavoured markdown. Address the reviewer's
  actual point. Say what you changed, or why you did not change it.

If a comment asks for a code change, make the change and commit it before you
answer, then say so in the reply. If it asks a question, answer the question.
Answer as the author of this change, because you are: nothing in your reply
should mention how you came by the context.
