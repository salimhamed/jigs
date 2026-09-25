# API reference

The API has two halves. `blocks/*` are the workflow-side building blocks you
import in workflows: descriptors, types and the decisions that run on replay.
`steps/*` do the real work, and your factory wires them in through its
generated `jigs/steps.ts`. In workflow code, call routines such as `runAgent`
from `#jigs/routines`, and steps such as `provisionWorktree` from `#jigs/steps`.
