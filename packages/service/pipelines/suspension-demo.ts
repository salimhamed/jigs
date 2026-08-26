import { z } from "zod";
import { claimTicket } from "../src/suspension/claim";
import { needsHuman } from "../src/suspension/needs-human";
import {
  type GateWake,
  pullRequestGate,
} from "../src/suspension/pull-request-gate";

export const suspensionDemoInputs = z.object({
  issueId: z.uuid(),
  pr: z
    .object({
      owner: z.string(),
      repo: z.string(),
      number: z.number().int().positive(),
    })
    .optional(),
  askHuman: z.boolean().default(false),
});

type SuspensionDemoInputs = z.output<typeof suspensionDemoInputs> & {
  triggerId: string;
};

export async function suspensionDemoPipeline(inputs: SuspensionDemoInputs) {
  "use workflow";

  const claim = await claimTicket(inputs.issueId);
  console.log(`[suspension-demo] claimed ${claim.token}`);

  let reply = null;
  if (inputs.askHuman) {
    reply = await needsHuman(claim, "suspension-demo needs a human", {
      triggerId: inputs.triggerId,
    });
    console.log(`[suspension-demo] human replied comment=${reply.commentId}`);
  }

  const wakes: GateWake[] = [];
  if (inputs.pr !== undefined) {
    for await (const wake of pullRequestGate(inputs.pr)) {
      console.log(`[suspension-demo] gate wake kind=${wake.kind}`);
      wakes.push(wake);
    }
  }

  return { claimed: claim.token, reply, wakes };
}
