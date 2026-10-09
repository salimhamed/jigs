# @jigs-ai/hub-protocol — agent guide

The repo root's `AGENTS.md` covers commands, releases, docs and the issue
tracker.

The messages the hub and a factory exchange. The package is private and never
published: `@jigs-ai/jigs` bundles it into its `dist/`, and other workspace
packages import its TypeScript source from `src/index.ts`. So:

- Import nothing at runtime that `@jigs-ai/jigs` does not already depend on, or
  the bundled copy breaks in a factory.
- Keep it free of Node built-ins, `process.env` and I/O: it describes messages,
  it does not send them.
- `src/index.ts` is types plus the paths and limits both sides agree on. The
  hub and jigs both build against it, so a change to a shape changes both
  sides in the same PR.
