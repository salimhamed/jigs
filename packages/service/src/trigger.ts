// The one trigger path: validate the inputs, preflight the pipeline's
// requirements, resolve a ticket ref, create the run. The HTTP
// route and the schedule ticker both go through here, so a scheduled fire is
// an ordinary run and neither caller can drift from the other's checks.

import type { CheckReport } from "jigs/checks";
import { start } from "workflow/api";
import type { z } from "zod";
import type { Factory } from "./factory";
import { preflight } from "./preflight";
import { resolveIssueRef } from "./providers/linear";

export type StartRunResult =
  | { kind: "started"; runId: string }
  | { kind: "unknown-pipeline"; knownPipelines: string[] }
  | { kind: "invalid-inputs"; issues: z.core.$ZodIssue[] }
  | { kind: "invalid-ticket"; reason: string }
  | { kind: "preflight-failed"; report: CheckReport };

export async function startRun(
  factory: Factory,
  pipelineName: string,
  inputs: unknown,
  triggerId: string,
): Promise<StartRunResult> {
  const entry = factory.pipelines[pipelineName];
  if (!entry) {
    return {
      kind: "unknown-pipeline",
      knownPipelines: Object.keys(factory.pipelines),
    };
  }

  // zod-parsed plain JSON is also the serialization guard: unserializable
  // workflow args leave a run stuck `running` forever (workflow@4.8.4).
  const parsed = entry.inputs.safeParse(inputs ?? {});
  if (!parsed.success) {
    return { kind: "invalid-inputs", issues: parsed.error.issues };
  }

  // Before the run exists: every failure at once, each carrying its repair,
  // and no run created. There is no skip flag.
  const report = await preflight(entry.requires ?? {});
  if (!report.ok) return { kind: "preflight-failed", report };

  let issue: { id: string; identifier: string } | undefined;
  if (hasTicket(parsed.data)) {
    try {
      issue = await resolveIssueRef(parsed.data.ticket);
    } catch (err) {
      return { kind: "invalid-ticket", reason: String(err) };
    }
  }

  const run = await start(entry.pipeline, [
    {
      ...parsed.data,
      triggerId,
      ...(issue === undefined
        ? {}
        : { issueId: issue.id, identifier: issue.identifier }),
    },
  ]);
  return { kind: "started", runId: run.runId };
}

function hasTicket(value: unknown): value is { ticket: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "ticket" in value &&
    typeof value.ticket === "string"
  );
}
