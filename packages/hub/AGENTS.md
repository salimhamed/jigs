# @jigs-ai/hub — agent guide

The repo root's `AGENTS.md` covers commands, releases, docs and the issue
tracker.

The hub is private until it ships. Today it is a plain `node:http` server:
`src/server.ts` builds it and `src/main.ts` starts it on `HOST` and `PORT` and
exits 0 on SIGTERM once open connections close. `pnpm --filter @jigs-ai/hub
start` runs it from source. Keep the SIGTERM test passing: the hub must stop
on its own when its process manager asks.

Messages the hub exchanges with a factory belong in `@jigs-ai/hub-protocol`,
not here, so jigs can share them.
