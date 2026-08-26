import type { z } from "zod";
import { demoInputs, demoPipeline } from "../pipelines/demo";

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
} satisfies Record<string, AnyPipelineEntry>;

export const registry: Record<string, AnyPipelineEntry> = entries;
