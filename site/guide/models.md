# Ask a model

Use `askModel` when the model only needs information you supply: summarizing text,
classifying a result, or turning a description into structured data. It runs
without tools or a worktree. Use [an agent](./agents) when the model needs to
inspect files or take actions.

This fragment belongs inside a factory workflow. It supplies all the text the
model needs and asks for a structured answer:

```ts
import { models } from "@salimhamed/jigs/blocks/agents";
import { z } from "zod";
import { askModel } from "#jigs";

const result = await askModel({
  model: models.openrouter("anthropic/claude-haiku-4.5"),
  prompt: "Summarize this result in one sentence: The build passed, but two integration tests failed because the database was unavailable.",
  output: z.object({ summary: z.string() }),
});

// result.output.summary is a string validated against the schema.
```

The call uses the model source's own API driver. A model request can include a
`system` instruction, but it cannot use MCP servers; configure tool access on
`runAgent` instead.

The durable operation records the response. Your workflow receives `text`, the
parsed `output` when you supplied a schema, and usage information when the
provider supplies it. Schema validation checks the answer’s shape, not its factual
accuracy; decide what review the result needs before acting on it.

See the [API reference](/api/) for model request and result types.
