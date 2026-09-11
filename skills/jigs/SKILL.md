---
name: jigs
description: Work with a jigs software factory — operate its runs, author its pipelines, set one up, or answer a question about how jigs works.
disable-model-invocation: true
argument-hint: "<run …, add …, set up …, or a question about jigs>"
---

# jigs

Read the argument, pick **exactly one** route, read that file, and follow it.
Read only the file you picked.

| The argument is about | Route |
| --- | --- |
| Running, watching, cancelling, sweeping or poking runs; a run that looks stuck; answering a needs-human halt | `operate.md` |
| Adding or changing a pipeline, block, step, prompt, schedule, or a `requires` manifest | `author.md` |
| Installing jigs, initialising a factory, binding a repo, bringing a service up | `setup.md` |
| A question — what a term means, why something works the way it does, where something lives | `ask.md` |

Routing rules:

- A directory with no `jigs.yml` at its root is not a factory repo. Any request
  that needs one goes to `setup.md` first, whatever it asked for.
- A question phrased as a request ("can you cancel that run?") is a request.
  A request phrased as a question ("why is my run stuck?") is a request too —
  that one is `operate.md`. `ask.md` is only for questions that want an answer
  and no change.
- If the argument is empty, ask which of the four is wanted. Do not guess.

On every route, flags are read rather than recalled: `jigs --help` and
`jigs <verb> --help` are the source. The route files say which command and why.
