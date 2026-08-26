import type { z } from "zod";

export interface PipelineEntry<S extends z.ZodType = z.ZodType> {
  pipeline: (inputs: z.output<S> & { triggerId: string }) => Promise<unknown>;
  inputs: S;
  hookToken?: (triggerId: string) => string;
}

// biome-ignore lint/suspicious/noExplicitAny: heterogeneous schemas per entry
export const registry: Record<string, PipelineEntry<any>> = {};
