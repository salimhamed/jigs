# Bindings are committed factory configuration

A binding maps a name to a remote URL and worktree provisioning options in the
factory's committed `jigs.config.ts`. jigs keeps its own bare clone per binding;
the operator's checkout is not part of it. Default branches and current state
are derived from git when needed.

The same configuration declares ports, ingress URL, schedules and deferred
workflow imports. A workflow module exports its function, schema and requirements
together. Operating commands load configuration without invoking those imports,
so broken workflow code does not prevent reading service settings. The built
service resolves the imports. Secrets remain in `.env`.

`jigs bind` and `jigs unbind` use a TypeScript syntax tree to edit ordinary
literal bindings while preserving surrounding code and comments. If the relevant
expression is computed, duplicated, spread or otherwise ambiguous, they fail
with an actionable message before writes or webhook actions. This is an editing
restriction only; loading computed configuration remains supported. There is no
custom lint rule or configuration language.

Provisioning options are `copy`, `postCreate` and `hookTimeoutMinutes`. Copy
paths are relative to `bindings/<name>/` in the factory. All configuration is
reviewable in one place rather than split between YAML and TypeScript, a
user-level registry, or runtime state. The cost of automatic TypeScript edits is
bounded by explicitly refusing syntax the editor cannot safely modify.
