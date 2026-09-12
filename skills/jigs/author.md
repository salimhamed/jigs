# Author a workflow

Work in the factory repo. Read its `jigs.config.ts`, generated `jigs.ts`, and
existing `workflows/`, `blocks/`, and `steps/` before editing. The installed
`node_modules/@salimhamed/jigs/templates/` is the scaffold for that version.

## Code responsibilities

- A workflow is a named process with a `"use workflow"` async function.
- A block coordinates durable steps and makes replay-safe decisions. It has no
  directive. No filesystem, network, environment reads, or Node built-ins.
- A step has `"use step"` and performs work the runtime records. Keep custom
  steps in `steps/`; their implementations may use Node and external services.
- `jigs.ts` is generated and committed. Import built-in steps and bound blocks
  from it. Never add custom behavior or prompts there. `jigs generate` refreshes
  it; builds check for drift and upgrades regenerate it automatically.

A workflow calls blocks and steps. A step calls an implementation. Only the
factory carries directives, so library version changes do not rename its steps.
Names and paths can be improved, but changing them changes durable addresses:
check active and parked runs before deploying a rename, and arrange their
completion or cancellation with the operator.

## Add a workflow

1. Write `workflows/<name>.ts` with a zod input schema and an exported async
   function whose first statement is `"use workflow"`.
2. Type inputs as `WorkflowInputs<typeof inputs>`, or
   `TicketWorkflowInputs<typeof inputs>` for required ticket inputs. These
   include the trigger's injected fields. Do not resolve the ticket again.
3. Default-export `{ workflow: functionName, inputs, requires }` from the module.
4. Register `name: () => import("./workflows/<name>.ts")` in the config's
   `workflows` object. Keep imports deferred so operating commands don't load
   workflow code.
5. Build and test the factory. Its config test checks the emitted durable IDs.

Teardown is a plain last call, never a `finally`: suspension can throw, and a
parked run must retain its worktree. Configuration values vary by factory;
requirements belong to the workflow declaration next to its input schema.

## Customize blocks and steps

Pass typed prompt overrides directly to jigs blocks. For shared defaults, write
one custom block wrapping the shipped block, with defaults before the spread
of caller options so a call site can override them.

For different durable behavior, write a named custom `"use step"` function.
`bindJigs` from `@salimhamed/jigs/blocks` accepts the `jigsSteps` exported by
local `jigs.ts`, with individual steps replaced:

```ts
const blocks = bindJigs({ ...jigsSteps, postNeedsHumanComment: customComment });
```

Keep renderer functions inside the custom step that calls the implementation;
functions are not ordinary serializable step inputs. Preserve the current `Halt`
structure, run metadata and ticket-note behavior when replacing comment steps.

## Prompts

Prompts are typed functions in `.prompt.ts` files beside their callers. Use the
shipped prompt types for overrides. `reviewTicket` accepts `prompt`, the
implementation/review block accepts `implementPrompt` and `codeReviewPrompt`,
and CI/review-response blocks accept `freshPrompt` and `resumePrompt`.
Keep prompt choices out of generated integration; no central prompt registry
is needed. The scaffold's PR prompt is beside `describe-and-open-pr.ts`.

## Configuration and schedules

`jigs.config.ts` declares ports, ingress URL, bindings, deferred workflow imports
and schedules. Secrets remain in `.env`. A schedule names a `workflow`, cron
expression and inputs; the service validates its inputs against the workflow's
schema. An active prior run causes a tick to be skipped; downtime isn't replayed.

Use `jigs bind` and `jigs unbind` for literal binding declarations. Unsupported
computed expressions fail with guidance before any file or webhook changes.
Do not replace such expressions automatically to make an edit work.

## Verify

```sh
pnpm typecheck
pnpm exec jigs build
pnpm test
```

A running service needs `jigs up` to pick up changes. Check active runs before
restarting it. Never run standalone `workflow web` against its World; the
service hosts its own dashboard. Cancellation and destructive worktree cleanup
require operator authorization unless already authorized in the session.
