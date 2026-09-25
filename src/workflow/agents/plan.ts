import type { z } from "zod";
import { JigsError } from "../errors.ts";
import type { AskableHarness, AskableModelSource, Harness } from "./harness-config.ts";
import { dropNullOptionals, type OutputJsonSchema, toOutputJsonSchema } from "./output-schema.ts";
import type { AgentSession } from "./result.ts";

/** Options for an agent that works inside a directory. */
export type RunAgentOptions<T = undefined> = {
  harness: Harness;
  cwd: string;
  prompt: string;
  resume?: AgentSession;
  output?: z.ZodType<T>;
};
/** Options for one harness turn without tools or a worktree. */
export type AskAgentOptions<T = undefined> = {
  harness: AskableHarness;
  prompt: string;
  system?: string;
  output?: z.ZodType<T>;
};
/** Options for one API model call. */
export type AskModelOptions<T = undefined> = {
  model: AskableModelSource;
  prompt: string;
  system?: string;
  output?: z.ZodType<T>;
};

export type { OutputJsonSchema } from "./output-schema.ts";
/**
 * Serializable agent request passed to a durable step.
 *
 * @group Factory plumbing
 */
export type AgentRequest =
  | (Omit<RunAgentOptions, "output"> & { outputSchema?: OutputJsonSchema })
  | (Omit<AskAgentOptions, "output"> & {
      cwd?: never;
      resume?: never;
      outputSchema?: OutputJsonSchema;
    });
/**
 * Serializable API model request passed to a durable step.
 *
 * @group Factory plumbing
 */
export type ModelRequest = Omit<AskModelOptions, "output"> & { outputSchema?: OutputJsonSchema };

function withOutputSchema<T extends object>(
  wire: T,
  output: z.ZodType | undefined,
): T & { outputSchema?: OutputJsonSchema } {
  const outputSchema = output === undefined ? undefined : toOutputJsonSchema(output);
  return outputSchema === undefined ? wire : { ...wire, outputSchema };
}

/**
 * Convert run options into their durable wire form.
 *
 * @group Factory plumbing
 */
export function buildAgentRequest<T>(config: RunAgentOptions<T>): AgentRequest {
  const { output, ...wire } = config;
  return withOutputSchema(wire, output);
}
/** Reject a harness that cannot answer an `askAgent` call without tools. */
export function assertAskableHarness(harness: Harness): asserts harness is AskableHarness {
  if (harness.kind === "codex")
    throw new JigsError(
      "askAgent() cannot use the Codex harness — Codex has no mode without tools; use runAgent(), Claude Code or Pi",
    );
  if (harness.mcpServers !== undefined)
    throw new JigsError(
      "askAgent() has no MCP universe — mcpServers on the harness descriptor is only honored by runAgent()",
    );
  if (harness.kind === "pi" && harness.tools !== undefined)
    throw new JigsError(
      "askAgent() runs without tools — tools on the Pi harness descriptor is only honored by runAgent()",
    );
}
/**
 * Convert harness-ask options into their durable wire form.
 *
 * @group Factory plumbing
 */
export function buildAskAgentRequest<T>(config: AskAgentOptions<T>): AgentRequest {
  assertAskableHarness(config.harness);
  const { output, ...wire } = config;
  return withOutputSchema(wire, output);
}
/**
 * Convert model options into their durable wire form.
 *
 * @group Factory plumbing
 */
export function buildModelRequest<T>(config: AskModelOptions<T>): ModelRequest {
  const { output, ...wire } = config;
  return withOutputSchema(wire, output);
}
/** Validate recorded structured output with the caller's original zod schema. */
export function parseOutput<T>(schema: z.ZodType<T> | undefined, raw: unknown): T {
  return schema === undefined ? (undefined as T) : schema.parse(dropNullOptionals(schema, raw));
}
