# API reference

The API has two halves. `blocks/*` are the workflow-side building blocks you
import in workflows: descriptors, types and the decisions that run on replay.
`steps/*` do the real work, and your factory wires them in through its
generated `jigs.ts`. In workflow code, call the verbs, such as `runAgent`, from
`#jigs`.
