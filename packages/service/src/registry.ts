import type { z } from "zod";
import { demoInputs, demoPipeline } from "../pipelines/demo";
import { stepsDemoInputs, stepsDemoPipeline } from "../pipelines/steps-demo";
import {
  suspensionDemoInputs,
  suspensionDemoPipeline,
} from "../pipelines/suspension-demo";

export interface PipelineEntry<S extends z.ZodType = z.ZodType> {
  pipeline: (inputs: z.output<S> & { triggerId: string }) => Promise<unknown>;
  inputs: S;
  hookToken?: (triggerId: string) => string;
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
} satisfies Record<string, AnyPipelineEntry>;

export const registry: Record<string, AnyPipelineEntry> = entries;
