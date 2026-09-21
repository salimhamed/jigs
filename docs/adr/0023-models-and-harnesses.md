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
  AI SDK `LanguageModel` for it; Pi itself owns its agent loop.
- Subscription logins remain first-class for harnesses. API keys are never
  inherited globally: each driver explicitly allowlists the credentials its
  subprocess or API client may receive.
- The Pi and model-source descriptor types can exist before their drivers. An
  attempted execution fails explicitly with the unregistered kind.

This decision amends ADR 0004's statement that Pi is not a v0 harness.
