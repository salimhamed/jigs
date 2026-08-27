import type { PipelineRequires } from "jigs/checks";
import type { z } from "zod";
import { demoInputs, demoPipeline } from "../pipelines/demo";
import { jitDemoInputs, jitDemoPipeline } from "../pipelines/jit-demo";
import {
  preflightDemoInputs,
  preflightDemoPipeline,
} from "../pipelines/preflight-demo";
import { stepsDemoInputs, stepsDemoPipeline } from "../pipelines/steps-demo";
import {
  suspensionDemoInputs,
  suspensionDemoPipeline,
} from "../pipelines/suspension-demo";

export interface PipelineEntry<S extends z.ZodType = z.ZodType> {
  pipeline: (inputs: z.output<S> & { triggerId: string }) => Promise<unknown>;
  inputs: S;
  hookToken?: (triggerId: string) => string;
  // The manifest half of preflight's computed check list (ADR 0010).
  requires?: PipelineRequires;
}

// biome-ignore lint/suspicious/noExplicitAny: heterogeneous schemas per entry
type AnyPipelineEntry = PipelineEntry<any>;

const entries = {
  "demo-crash": {
    pipeline: demoPipeline,
    inputs: demoInputs,
    hookToken: (triggerId) => `demo:${triggerId}`,
  },
  "steps-demo": {
    pipeline: stepsDemoPipeline,
    inputs: stepsDemoInputs,
    hookToken: (triggerId) => `steps:${triggerId}`,
  },
  // Resume tokens are resource-scoped (linear:ticket:<uuid>, github:pr:...),
  // derived from inputs rather than the triggerId, so no hookToken here.
  "suspension-demo": {
    pipeline: suspensionDemoPipeline,
    inputs: suspensionDemoInputs,
  },
  "jit-demo": {
    pipeline: jitDemoPipeline,
    inputs: jitDemoInputs,
    requires: { harnesses: ["claude"] },
  },
  "preflight-demo": {
    pipeline: preflightDemoPipeline,
    inputs: preflightDemoInputs,
    requires: { bindings: ["api"], harnesses: ["claude"] },
  },
} satisfies Record<string, AnyPipelineEntry>;

export const registry: Record<string, AnyPipelineEntry> = entries;
