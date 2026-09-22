---
status: accepted
---

# Model sources and harnesses have separate execution contracts

Model sources are API endpoints. Harnesses are agent programs jigs spawns.
Workflow code passes only tagged serializable descriptors; step-side drivers
hydrate live providers and own execution, checks, environment allowlists,
session pointers and cost reporting.

The public constructor namespaces are `models.*` and `harnesses.*`. The four
execution verbs state which family they accept: `runAgent` and `askAgent` take
harnesses; `askModel` and `askJev` take model sources.

## Consequences

- One step-side driver registry is the source of installed execution kinds.
- Pi runs as a subprocess of the installed binary. jigs does not implement an
  AI SDK `LanguageModel` for it; Pi itself owns its agent loop. Pi's native
  request retries remain enabled, and jigs accepts a result only after Pi emits
  `agent_settled`, the final assistant outcome is successful, and the process
  closes normally. An earlier error that Pi recovers from does not poison the
  settled result.
- Pi's native retries, retries inside the AI SDK used by direct model calls,
  and Workflow step replay are separate layers. The Pi driver adds no retry
  loop of its own: exhausted Pi work rejects the step, after which Workflow
  decides whether to replay that whole durable operation. Stopping a running
  agent process remains part of the separate run-cancellation contract.
- Pi MCP support uses jigs' exact-pinned `pi-mcp-adapter`. Each run supplies a
  complete invocation-private configuration and named direct-tool allowlists;
  adapter proxy, scripting and ambient discovery surfaces remain disabled.
  The generated extension strips and blocks the adapter's temporary cache-miss
  proxy, disables resources, and prevents stdio children from inheriting Pi's
  model or sibling-server credentials.
  OAuth is permitted only through credentials already held by the adapter's
  secure store, and bearer secrets are resolved from named environment
  variables in step-side execution. Stdio environment entries and HTTP headers
  likewise map their target names to step-side source environment-variable
  names; literal secret values never enter the durable descriptor.
- Subscription logins remain first-class for harnesses. API keys are never
  inherited globally: each driver explicitly allowlists the credentials its
  subprocess or API client may receive. The Claude driver reapplies that
  policy at the provider's process-launch hook because the provider assembles
  its final child environment from the host after accepting jigs' environment.
  At that seam the driver captures the CLI's stderr and hands it to the
  provider on the launch error, so login failures still classify as such.
  This isolates environment credentials, not credential files available to
  the same operating-system user.
- Harness descriptors are reusable configuration, not mutable sessions.
  Generated settings and extensions belong to one invocation, while durable
  conversation files live separately. Continuation occurs only from an
  explicit, validated session pointer; unrelated execution failures never
  authorize a fresh-context fallback.
- The Pi and model-source descriptor types can exist before their drivers. An
  attempted execution fails explicitly with the unregistered kind.

This decision amends ADR 0004's statement that Pi is not a v0 harness.

AGE-506 amends this decision's cost-reporting clause: model, agent, and Jev
results no longer expose usage or costUsd, and drivers no longer own cost
reporting.
