# Answer a question about jigs

Answer the question from jigs' own sources, name the source, and stop. Change
nothing.

If what you were handed is a request rather than a question — cancel this,
add that, set this up — go back to `SKILL.md` and take the route it belongs to.

## Where to look, in this order

1. **`CONTEXT.md`** in the jigs checkout, for what a word means. It is the
   glossary: pipeline, jig, step, step id, step wrapper, run, binding, factory
   repo, suspension, satisfier, gate, needs-human halt, worktree, sweep,
   harness, snapshot, preflight, service, dashboard, trigger, schedule, World.
   Each entry also lists the words the project deliberately avoids — use the
   glossary's term, not a synonym.
2. **`docs/adr/`** in the jigs checkout, for *why* something works the way it
   does. One file per decision, each with the options that were rejected and
   what it cost. Cite them as `see docs/adr/<file>`. Several carry amendments at
   the top; a later amendment wins over the body it amends.
3. **`docs/setup.md`** in the jigs checkout, for *how* — the runbook for the
   machine once and a factory at a time.
4. **`jigs --help` and `jigs <verb> --help`**, for what a command and its flags
   actually do today. Prefer running these over recalling them.
5. **The source**, when the question is about behaviour none of the above pins
   down: `packages/jigs/src/` for the CLI and the check catalog,
   `packages/service/src/` for the service, its routes, and the step,
   suspension and worktree primitives.

For a question about how a factory is written rather than how jigs works, the
worked example is `e2e/fixture-factory/` in the jigs checkout.

## How to answer

- Quote the sentence you are relying on and name the file it came from.
- Distinguish what the sources say from what you infer. Say which you are doing.
- If the sources do not answer the question, say so plainly and say what you
  looked at. Do not fill the gap with a plausible answer.
- If two sources disagree, report the disagreement rather than picking a winner.
  A stale doc is worth knowing about.

## Commands you may run

Only read-only ones, and only when the question is about this factory's current
state:

```sh
jigs ps               # runs, worktrees, schedules
jigs doctor           # the check catalog against the running service
jigs service status   # is it up, and on which ports
jigs bindings         # the target repos this factory knows
jigs logs <run>       # one run's state, timeline and dashboard link
jigs --help
```

Nothing that changes state. Not `jigs run`, `cancel`, `poke`, `sweep`, `bind`,
`unbind`, `build`, or any `jigs service` verb other than `status`. No edits to
`jigs.yml`, `.env`, or any file. If the answer would require one of those, say
what you would need to do and let the human ask for it.
