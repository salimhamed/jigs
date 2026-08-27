import { claude } from "jigs/steps";
import { createHook } from "workflow";
import { z } from "zod";
import { agent, fn } from "../src/steps";

export const stepsDemoInputs = z.object({
  mode: z.enum(["replay", "bad-config"]).default("replay"),
});

type StepsDemoInputs = z.output<typeof stepsDemoInputs> & {
  triggerId: string;
};

// Step-builder acceptance demo. replay: a completed fn step must not
// re-execute on resume (its marker tells replay from re-execution).
// bad-config: a live function smuggled into agent() config must fail at the
// SDK serialization boundary, before any harness spawns.
export async function stepsDemoPipeline(inputs: StepsDemoInputs) {
  "use workflow";

  if (inputs.mode === "bad-config") {
    const poisoned = claude({ model: "sonnet" }) as ReturnType<
      typeof claude
    > & {
      onSpawn?: () => void;
    };
    poisoned.onSpawn = () => {};
    const never = await agent({
      harness: poisoned,
      cwd: "/nonexistent",
      prompt: "never reached — serialization fails first",
    });
    return { never };
  }

  const first = await fn(makeMarker, inputs.triggerId);

  // Keep in sync with the registry entry's hookToken.
  using hook = createHook<{ note?: string }>({
    token: `steps:${inputs.triggerId}`,
  });
  await hook;

  const second = await fn(echoMarker, first.output.marker);

  return { first, second };
}

async function makeMarker(triggerId: string) {
  "use step";
  const marker = crypto.randomUUID();
  console.log(`[fnStep] START marker=${marker} triggerId=${triggerId}`);
  return { marker };
}

async function echoMarker(marker: string) {
  "use step";
  console.log(`[fnStep] echo marker=${marker}`);
  return { echoed: marker };
}
