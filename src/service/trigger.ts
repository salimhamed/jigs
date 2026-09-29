import type { World } from "@workflow/world";
import { start } from "workflow/api";
import { getWorld } from "workflow/runtime";
import type { z } from "zod";
import { type CheckReport, preflightChecks, runChecks } from "../checks/index.ts";
import type { Factory, Injected } from "../workflow/factory.ts";

type Refusal =
  | { kind: "unknown-workflow"; knownWorkflows: string[] }
  | { kind: "invalid-inputs"; issues: z.core.$ZodIssue[] }
  | { kind: "preflight-failed"; report: CheckReport };

export type StartRunResult = { kind: "started"; runId: string } | Refusal;

/** A run that passed validation and preflight, ready for the World. With `runId`, `launch`
 *  creates it under that ID and queues nothing: the caller queues it with `enqueueRun` once it
 *  sees the run. */
export type PreparedRun =
  | { kind: "ready"; launch(triggerId: string, runId?: string): Promise<string> }
  | Refusal;

/** Everything before the World: input validation, then preflight. */
export async function prepareRun(
  factory: Factory,
  workflowName: string,
  inputs: unknown,
): Promise<PreparedRun> {
  const entry = factory.workflows[workflowName];
  if (!entry) {
    return {
      kind: "unknown-workflow",
      knownWorkflows: Object.keys(factory.workflows),
    };
  }

  // zod-parsed plain JSON is also the serialization guard: unserializable
  // Unserializable workflow args can leave a run stuck `running` forever.
  const parsed = entry.inputs.safeParse(inputs ?? {});
  if (!parsed.success) {
    return { kind: "invalid-inputs", issues: parsed.error.issues };
  }

  // Before the run exists: every failure at once, each carrying its repair,
  // and no run created. There is no skip flag.
  const report = await runChecks(preflightChecks(entry.requires ?? {}, parsed.data));
  if (!report.ok) return { kind: "preflight-failed", report };

  return {
    kind: "ready",
    async launch(triggerId, runId) {
      const args: [unknown] = [{ ...parsed.data, ...({ triggerId } satisfies Injected) }];
      const run = await (runId === undefined
        ? start(entry.workflow, args)
        : start(entry.workflow, args, { world: createOnly(await getWorld(), runId) }));
      return run.runId;
    },
  };
}

/** Validate, preflight and start a run. */
export async function startRun(
  factory: Factory,
  workflowName: string,
  inputs: unknown,
  triggerId: string,
): Promise<StartRunResult> {
  const prepared = await prepareRun(factory, workflowName, inputs);
  if (prepared.kind !== "ready") return prepared;
  return { kind: "started", runId: await prepared.launch(triggerId) };
}

// start() mints the run ID from its World's createRunId and queues the run's
// first delivery beside creating it, so a World that answers with this ID and
// queues nothing, for this call alone, creates the run under an ID the caller
// already recorded. The caller queues it once it sees the run: start()'s own
// delivery carries the run's input, which a second copy of would take the
// runtime's first-delivery path on a run that already exists.
function createOnly(world: World, runId: string): World {
  const bare = runId.slice("wrun_".length);
  return Object.create(world, {
    createRunId: { value: () => bare },
    queue: { value: async () => ({ messageId: null }) },
  }) as World;
}
