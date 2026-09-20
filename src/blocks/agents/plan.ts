// Workflow-side planning: builders call these before any step executes, so
// everything here must be pure and sandbox-safe — no node imports (this code
// is bundled into the workflow sandbox).

import type { z } from "zod";
import type { HarnessConfig } from "./harness-config.ts";
import { dropNullOptionals, type OutputJsonSchema, toOutputJsonSchema } from "./output-schema.ts";
import type { AgentSession } from "./result.ts";

/** Workflow-side options for an agent that works inside a directory. */
export type RunAgentOptions<T = undefined> = {
  harness: HarnessConfig;
  cwd: string;
  prompt: string;
  // A session pointer a previous agent step recorded. Nothing is validated
  // here: a pointer naming another harness is resolved at hydration, where
  // the harness actually is, and reports there as an unusable session.
  resume?: AgentSession;
  output?: z.ZodType<T>;
};

/** Workflow-side options for one model call without tools or a worktree. */
export type AskModelOptions<T = undefined> = {
  harness: HarnessConfig;
  prompt: string;
  system?: string;
  output?: z.ZodType<T>;
};

// `skills` is deliberately absent: on Claude, skills reach the agent through
// the worktree via the forced settingSources ['project'], so there is nothing
// for the builder to do until the worktree/jig ticket lands.

export type { OutputJsonSchema } from "./output-schema.ts";

/** Serializable agent request passed to a durable step. */
export type AgentRequest = Omit<RunAgentOptions, "output"> & {
  outputSchema?: OutputJsonSchema;
};

/** Serializable plain-model request passed to a durable step. */
export type ModelRequest = Omit<AskModelOptions, "output"> & {
  outputSchema?: OutputJsonSchema;
};

/** Convert workflow-side agent options into their durable wire form. */
export function buildAgentRequest<T>(config: RunAgentOptions<T>): AgentRequest {
  const { output, ...wire } = config;
  const outputSchema = output === undefined ? undefined : toOutputJsonSchema(output);
  return outputSchema === undefined ? wire : { ...wire, outputSchema };
}

/** Convert workflow-side model options into their durable wire form. */
export function buildModelRequest<T>(config: AskModelOptions<T>): ModelRequest {
  // A model step sees no MCP universe at all — declaring servers it can never
  // reach would be a silent lie, so it fails here instead.
  if (config.harness.mcpServers !== undefined) {
    throw new Error(
      "askModel() is a plain model call with no MCP universe — mcpServers on the harness descriptor is only honored by runAgent()",
    );
  }
  const { output, ...wire } = config;
  const outputSchema = output === undefined ? undefined : toOutputJsonSchema(output);
  return outputSchema === undefined ? wire : { ...wire, outputSchema };
}

// The executor asks the harness for schema-conformant output; the real
// validation is this workflow-side zod parse of the recorded raw output —
// deterministic on replay, and where the result gets its `T`.
/** Validate recorded structured output with the caller's original zod schema. */
export function parseOutput<T>(schema: z.ZodType<T> | undefined, raw: unknown): T {
  return schema === undefined ? (undefined as T) : schema.parse(dropNullOptionals(schema, raw));
}
