// Workflow-side planning: builders call these before any step executes, so
// everything here must be pure and sandbox-safe — no node imports (this code
// is bundled into the workflow sandbox).

import type { PermissionMode } from "ai-sdk-provider-claude-code";
import { z } from "zod";
import {
  type HarnessConfig,
  STRUCTURED_OUTPUT_SUPPORT,
  StructuredOutputUnsupportedError,
} from "./config.ts";

export type AgentStepConfig<T = undefined> = {
  harness: HarnessConfig;
  cwd: string;
  prompt: string;
  instructions?: string;
  // Mapped on Claude only: Codex approval/sandbox policies are jigs
  // invariants set at hydration, not authoring surface.
  permissionMode?: PermissionMode;
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

export type AgentWire = {
  harness: HarnessConfig;
  cwd: string;
  prompt: string;
  instructions?: string;
  permissionMode?: PermissionMode;
  outputSchema?: WireJsonSchema;
};

export type AskWire = {
  harness: HarnessConfig;
  prompt: string;
  system?: string;
  outputSchema?: WireJsonSchema;
};

function checkOutputCapability(
  harness: HarnessConfig,
  output: z.ZodType | undefined,
): void {
  if (
    output !== undefined &&
    STRUCTURED_OUTPUT_SUPPORT[harness.kind] !== true
  ) {
    throw new StructuredOutputUnsupportedError(harness.kind);
  }
}

function toWireSchema(
  output: z.ZodType | undefined,
): WireJsonSchema | undefined {
  if (output === undefined) return undefined;
  // The Claude CLI rejects zod's $schema meta-declaration outright ("no
  // schema with key or ref"); neither harness needs it.
  const { $schema: _dropped, ...schema } = z.toJSONSchema(
    output,
  ) as WireJsonSchema;
  return schema;
}

export function buildAgentWire<T>(config: AgentStepConfig<T>): AgentWire {
  checkOutputCapability(config.harness, config.output);
  const wire: AgentWire = {
    harness: config.harness,
    cwd: config.cwd,
    prompt: config.prompt,
  };
  if (config.instructions !== undefined)
    wire.instructions = config.instructions;
  if (config.permissionMode !== undefined)
    wire.permissionMode = config.permissionMode;
  const outputSchema = toWireSchema(config.output);
  if (outputSchema !== undefined) wire.outputSchema = outputSchema;
  return wire;
}

export function buildAskWire<T>(config: AskStepConfig<T>): AskWire {
  checkOutputCapability(config.harness, config.output);
  // A model step sees no MCP universe at all — declaring servers it can never
  // reach would be a silent lie, so it fails here instead.
  if (config.harness.mcpServers !== undefined) {
    throw new Error(
      "ask() is a plain model call with no MCP universe — mcpServers on the harness descriptor is only honored by agent()",
    );
  }
  const wire: AskWire = {
    harness: config.harness,
    prompt: config.prompt,
  };
  if (config.system !== undefined) wire.system = config.system;
  const outputSchema = toWireSchema(config.output);
  if (outputSchema !== undefined) wire.outputSchema = outputSchema;
  return wire;
}
