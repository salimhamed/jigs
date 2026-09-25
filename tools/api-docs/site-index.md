# API reference

Most factory code uses three imports:

| Import | Use it for |
| --- | --- |
| [`@jigs-ai/jigs`](/api/jigs) | Factory/workflow definitions, harness and model descriptors, types, schemas, errors and pure helpers |
| [`#jigs/routines`](/api/factory/routines) | Workflow operations that compose durable steps and waits |
| [`#jigs/steps`](/api/factory/steps) | Durable steps generated into your factory |

The factory pages are generated from the same templates as `jigs generate`, so
they show the signatures workflow code actually calls. Commit the generated
`jigs/` directory; see [Core concepts](/guide/concepts#why-jigs-generates-code-in-your-factory).

`@jigs-ai/jigs/steps` and `@jigs-ai/jigs/steps/*` are lower-level building blocks
for factory-owned custom `"use step"` implementations. They do not carry step
directives themselves. Most workflow code should use the generated imports
above. See [Custom agent steps](/guide/custom-agent-step) before using the
[runner APIs](/api/steps).
