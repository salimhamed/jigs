# Bindings are committed factory configuration

Status: accepted

A binding maps a name to a remote URL and worktree provisioning options in the
factory's committed `jigs.config.ts`. jigs keeps its own bare clone per binding;
the operator's checkout is never used. Default branches and current state are
derived from git when needed. Secrets stay in `.env`.

The same file declares ports, webhooks, schedules and the factory's workflows as
deferred imports. A workflow module exports its function, schema and
requirements together. Operating commands load the configuration without
invoking those imports, so broken workflow code does not stop anyone reading
service settings; only the built service resolves them.

Provisioning options are `copy`, `postCreate` and `hookTimeoutMinutes`. Copy
paths are relative to `bindings/<name>/` in the factory.

## Consequences

- `jigs bind` and `jigs unbind` edit the file through a TypeScript syntax tree,
  preserving surrounding code and comments. A computed, duplicated, spread or
  otherwise ambiguous expression makes them fail with an actionable message
  before any write or webhook action. This restricts editing only: computed
  configuration still loads.
- There is no YAML file, user-level registry, custom lint rule or
  configuration language. All configuration is reviewable in one place.
- Moving a workflow import out of the deferred form would make every operating
  command load workflow code, and fail with it.
