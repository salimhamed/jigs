# API reference

The API has two halves. The root, `jigs`, is what workflow code imports:
descriptors, types, schemas and pure renderers. `steps/*` do the real work,
and your factory wires them in through its generated `jigs/steps.ts`. In
workflow code, call routines such as `runAgent` from `#jigs/routines`, and
steps such as `provisionWorktree` from `#jigs/steps`.
