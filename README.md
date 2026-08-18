# jigs

> In manufacturing, a jig guides tools through repeatable operations.
> In software, Jigs guides coding agents through repeatable workflows.

A lights-on software development factory: define pipelines that take tickets
through implementation, review, and iteration by AI agents — blocking for
human approval where it matters.

**Status:** early scaffolding. The CLI currently prints Hello World.

## Development

Requires Node >= 24 and pnpm.

```sh
pnpm install
pnpm dev        # run the CLI from source
pnpm check      # lint + typecheck + test + build
node dist/cli.js
```
