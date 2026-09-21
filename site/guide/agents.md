# Run an agent

Use `runAgent` when the work needs tools and a working directory: inspecting code,
running checks, or making a change. A **harness** is the coding-agent runtime that
does the work. jigs supports Claude Code and Codex.

Import the bound operation from your factory’s generated `#jigs` module. The
harness descriptor comes from the jigs package.

This is a fragment to use inside a factory workflow. `worktreePath` stands for
the path of a worktree you have provisioned for this run:

```ts
import { harnesses } from "@salimhamed/jigs/blocks/agents";
import { runAgent } from "#jigs";

const result = await runAgent({
  harness: harnesses.claude("sonnet"),
  cwd: worktreePath,
  prompt: "Read the README and summarize how to run this project's tests. Do not change files.",
});

// result.text contains the agent's answer.
```

Choose a model available to your authenticated harness. A workflow that needs
no Git repository can instead use `createRunDirectory()` for scratch space.

## Keep conversations separate

An agent result can include a `session` pointer. Pass it as `resume` to a later
call when you want to continue that conversation. Keep an independent reviewer
in its own session, and do not share a session between different harnesses.
Session availability is not guaranteed; decide what your workflow should do
when a conversation cannot be resumed.

Each concurrently working agent needs its own working directory. jigs locks an
agent’s directory during execution so two agents cannot edit it at once.

## Make outputs useful to the next step

You can supply a Zod schema through `output` when later code needs structured
data. The parsed value appears in `result.output`; plain text is in `result.text`.
The [model guide](./models) shows a small schema example.

For a complete implementation-and-review process, start with the
[ship recipe](./ship). For individual options and session types, use the
[API reference](/api/).
