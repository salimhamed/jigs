import { start } from "workflow/api";
import type { z } from "zod";
import { type Factory, type Injected, RUN_TICKET_ATTRIBUTE } from "../blocks/factory.ts";
import {
  CLEANUP_DIRECTIVE_ATTRIBUTE,
  CLEANUP_STATE_ATTRIBUTE,
  encodeCleanupProgress,
} from "../blocks/runtime/cleanup.ts";
import { type CheckReport, preflightChecks, runChecks } from "../checks/index.ts";

export type StartRunResult =
  | { kind: "started"; runId: string }
  | { kind: "unknown-workflow"; knownWorkflows: string[] }
  | { kind: "invalid-inputs"; issues: z.core.$ZodIssue[] }
  | { kind: "preflight-failed"; report: CheckReport };

export async function startRun(
  factory: Factory,
  workflowName: string,
  inputs: unknown,
  triggerId: string,
): Promise<StartRunResult> {
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

  const injection = { triggerId } satisfies Injected;
  const ticket =
    typeof parsed.data === "object" &&
    parsed.data !== null &&
    "ticket" in parsed.data &&
    typeof parsed.data.ticket === "string"
      ? parsed.data.ticket
      : undefined;

  const run = await start(entry.workflow, [{ ...parsed.data, ...injection }], {
    attributes: {
      [CLEANUP_DIRECTIVE_ATTRIBUTE]: "automatic",
      [CLEANUP_STATE_ATTRIBUTE]: encodeCleanupProgress({ status: "waiting" }),
      ...(ticket === undefined ? {} : { [RUN_TICKET_ATTRIBUTE]: ticket }),
    },
    allowReservedAttributes: true,
  });
  return { kind: "started", runId: run.runId };
}
