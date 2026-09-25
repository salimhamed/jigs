# Answer a question about jigs

Answer the question from jigs' own sources, name the source, and stop. Change
nothing.

If what you were handed is a request rather than a question — cancel this,
add that, set this up — go back to `SKILL.md` and take the route it belongs to.

## Where to look, in this order

1. **The documentation site.** Fetch
   `https://salimhamed.github.io/jigs/llms-full.txt` first: every guide page in
   one file. Then read the page that fits, under
   `https://salimhamed.github.io/jigs/guide/`:

   | Question | Page |
   | --- | --- |
   | What a term means | `concepts` |
   | What jigs is for | `why-jigs` |
   | Installing and a first run | `getting-started` |
   | Writing a workflow | `build-a-workflow` |
   | Harnesses and model sources | `models-and-harnesses` |
   | Recipes such as linear-ticket-to-pr | `recipes` |
   | `jigs.config.ts` and `.env` | `configuration` |
   | What a command does | `cli` |
   | Something failing | `troubleshooting` |

2. **The installed API reference**, `node_modules/@jigs-ai/jigs/docs/api/` in a
   factory. Its Markdown paths mirror the package import paths.
3. **`jigs --help` and `jigs <verb> --help`**, for what a command and its flags
   do in the installed version.
4. **The installed source**, when nothing above pins the behaviour down:
   `node_modules/@jigs-ai/jigs/dist/` (compiled; the package exports map names
   each module) and `node_modules/@jigs-ai/jigs/templates/`, one `.tmpl` per
   file `jigs init` writes. A factory that added the linear-ticket-to-pr recipe also has
   `workflows/linear-ticket-to-pr/delivery/README.md`.

## How to answer

- Quote the sentence you are relying on and name the page or file it came from.
- Distinguish what the sources say from what you infer. Say which you are doing.
- If the sources do not answer the question, say so plainly and say what you
  looked at, rather than filling the gap with a plausible answer.
- If two sources disagree, report the disagreement rather than picking a winner.
  A stale doc is worth knowing about.

## Commands you may run

Only read-only ones, and only when the question is about this factory's current
state:

```sh
jigs status           # runs, worktrees, schedules
jigs doctor           # the check catalog against the running service
jigs service status   # is it up, and on which ports
jigs bindings         # the target repos this factory knows
jigs status <run-id>  # one run's state, timeline and dashboard link
jigs --help
```

Nothing that changes state: not `jigs run`, `cancel`, `poke`, `resources prune
--apply`, `bind`, `unbind`, `generate`, `build`, `up`, `upgrade`, or any `jigs
service` verb other than `status`, and no file edits. If the answer would need
one of those, say what you would do and let the human ask for it.
