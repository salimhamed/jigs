import { z } from "zod";

export const preflightDemoInputs = z.object({
  note: z.string().default("preflight-demo"),
});

type PreflightDemoInputs = z.output<typeof preflightDemoInputs> & {
  triggerId: string;
};

// Preflight acceptance vehicle: the body is trivial on purpose — what is
// under test is the `requires` manifest and the refusal that happens before
// this ever runs.
export async function preflightDemoPipeline(inputs: PreflightDemoInputs) {
  "use workflow";
  return { note: inputs.note, triggerId: inputs.triggerId };
}
