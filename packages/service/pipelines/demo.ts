import { createHook } from "workflow";
import { z } from "zod";

export const demoInputs = z.object({
  stepSeconds: z.number().int().min(1).max(600).default(3),
});

type DemoInputs = z.output<typeof demoInputs> & { triggerId: string };

// Crash-model demo: slowStep's marker tells replay (same marker) from
// re-execution (new marker) across a process kill.
export async function demoPipeline(inputs: DemoInputs) {
  "use workflow";

  const slow = await slowStep(inputs.triggerId, inputs.stepSeconds);

  // Hook tokens are a global namespace per backend (duplicates fail the
  // run), so the token embeds the route-minted triggerId. Keep in sync with
  // the registry entry's hookToken.
  using hook = createHook<{ approved: boolean; note?: string }>({
    token: `demo:${inputs.triggerId}`,
  });
  const approval = await hook;

  const final = await finalStep(slow.marker, approval);

  return { slowStep: slow, approval, finalStep: final };
}

async function slowStep(triggerId: string, stepSeconds: number) {
  "use step";
  const marker = crypto.randomUUID();
  console.log(
    `[slowStep] START triggerId=${triggerId} marker=${marker} pid=${process.pid} seconds=${stepSeconds}`,
  );
  await new Promise((resolve) => setTimeout(resolve, stepSeconds * 1000));
  console.log(`[slowStep] END triggerId=${triggerId} marker=${marker}`);
  return { marker, finishedAt: new Date().toISOString() };
}

async function finalStep(
  sawMarker: string,
  approval: { approved: boolean; note?: string },
) {
  "use step";
  console.log(
    `[finalStep] executed sawMarker=${sawMarker} approved=${approval.approved}`,
  );
  return { sawMarker, completedAt: new Date().toISOString() };
}
