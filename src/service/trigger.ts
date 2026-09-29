import { start } from "workflow/api";
import type { z } from "zod";
import { type CheckReport, preflightChecks, runChecks } from "../checks/index.ts";
import type { Factory, Injected } from "../workflow/factory.ts";

type Refusal =
  | { kind: "unknown-workflow"; knownWorkflows: string[] }
  | { kind: "invalid-inputs"; issues: z.core.$ZodIssue[] }
  | { kind: "preflight-failed"; report: CheckReport };

export type StartRunResult = { kind: "started"; runId: string } | Refusal;

/** A run that passed validation and preflight, ready for the World. `attributes` are seeded on
 *  the run as plaintext, so they stay readable when the World encrypts its inputs. */
export type PreparedRun =
  | {
      kind: "ready";
      launch(triggerId: string, attributes?: Record<string, string>): Promise<string>;
    }
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
    async launch(triggerId, attributes) {
      const args: [unknown] = [{ ...parsed.data, ...({ triggerId } satisfies Injected) }];
      const run = await (attributes === undefined
        ? start(entry.workflow, args)
        : start(entry.workflow, args, { attributes }));
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
  attributes?: Record<string, string>,
): Promise<StartRunResult> {
  const prepared = await prepareRun(factory, workflowName, inputs);
  if (prepared.kind !== "ready") return prepared;
  return { kind: "started", runId: await prepared.launch(triggerId, attributes) };
}
