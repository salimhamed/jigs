// Workflow-side planning: builders call these before any step executes, so
// everything here must be pure and sandbox-safe — no node imports (this code
// is bundled into the workflow sandbox).

import { z } from "zod";
import type { HarnessConfig } from "./harness-config.ts";
import type { AgentSession } from "./result.ts";

export type AgentStepConfig<T = undefined> = {
  harness: HarnessConfig;
  cwd: string;
  prompt: string;
  // A session pointer a previous agent step recorded. Nothing is validated
  // here: a pointer naming another harness is resolved at hydration, where
  // the harness actually is, and reports there as an unusable session.
  resume?: AgentSession;
  output?: z.ZodType<T>;
};

export type AskStepConfig<T = undefined> = {
  harness: HarnessConfig;
  prompt: string;
  system?: string;
  output?: z.ZodType<T>;
};

// `skills` is deliberately absent: on Claude, skills reach the agent through
// the worktree via the forced settingSources ['project'], so there is nothing
// for the builder to do until the worktree/jig ticket lands.

export type WireJsonSchema = Record<string, unknown>;

export type AgentWire = Omit<AgentStepConfig, "output"> & {
  outputSchema?: WireJsonSchema;
};

export type AskWire = Omit<AskStepConfig, "output"> & {
  outputSchema?: WireJsonSchema;
};

function toWireSchema(output: z.ZodType | undefined): WireJsonSchema | undefined {
  if (output === undefined) return undefined;
  // The Claude CLI rejects zod's $schema meta-declaration outright ("no
  // schema with key or ref"); neither harness needs it.
  const { $schema: _dropped, ...schema } = z.toJSONSchema(output) as WireJsonSchema;
  return schema;
}

export function buildAgentWire<T>(config: AgentStepConfig<T>): AgentWire {
  const { output, ...wire } = config;
  const outputSchema = toWireSchema(output);
  return outputSchema === undefined ? wire : { ...wire, outputSchema };
}

export function buildAskWire<T>(config: AskStepConfig<T>): AskWire {
  // A model step sees no MCP universe at all — declaring servers it can never
  // reach would be a silent lie, so it fails here instead.
  if (config.harness.mcpServers !== undefined) {
    throw new Error(
      "ask() is a plain model call with no MCP universe — mcpServers on the harness descriptor is only honored by agent()",
    );
  }
  const { output, ...wire } = config;
  const outputSchema = toWireSchema(output);
  return outputSchema === undefined ? wire : { ...wire, outputSchema };
}

// The executor asks the harness for schema-conformant output; the real
// validation is this workflow-side zod parse of the recorded raw output —
// deterministic on replay, and where the result gets its `T`.
export function parseOutput<T>(schema: z.ZodType<T> | undefined, raw: unknown): T {
  return schema === undefined ? (undefined as T) : schema.parse(raw);
}
