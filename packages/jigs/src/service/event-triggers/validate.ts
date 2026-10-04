// What makes a trigger or schedule runnable beyond what jigs.config.ts checks
// when it loads: the parts that need the service's sources or the loaded
// workflow. The boot refuses one that fails, and doctor reports the same
// failure on demand.

import type { z } from "zod";
import type { EventTrigger, Factory } from "../../workflow/factory.ts";
import { DEFAULT_LOOKBACK_MINUTES, DEFAULT_MAX_ACTIVE } from "../../workflow/factory-schema.ts";
import type { Source, SourceRegistry } from "./sources.ts";

/** Why a declaration in jigs.config.ts cannot run, and how to fix it there. */
export interface ConfigProblem {
  reason: string;
  repair: string;
}

/** A trigger whose declaration holds, resolved to what the engine runs. */
export interface ValidTrigger {
  name: string;
  trigger: EventTrigger;
  source: Source;
  params: unknown;
  maxActive: number;
  lookbackMinutes: number;
  workflowName: string | undefined;
}

export function issues(list: z.core.$ZodIssue[]): string {
  return list.map((issue) => `${issue.path.join(".") || "(root)"} ${issue.message}`).join("; ");
}

export function resolveTrigger(
  factory: Factory,
  name: string,
  trigger: EventTrigger,
  sources: SourceRegistry,
): ValidTrigger | ConfigProblem {
  const at = `triggers.${name}`;
  const entry = factory.workflows[trigger.workflow] as Factory["workflows"][string];
  const source = sources[trigger.source.kind];
  if (source === undefined) {
    return {
      reason: `source "${trigger.source.kind}" is not a source this jigs version provides`,
      repair: `set ${at}.source in jigs.config.ts to one of: ${Object.keys(sources).join(", ")}`,
    };
  }
  const params = source.params.safeParse(trigger.source.params);
  if (!params.success) {
    return {
      reason: `source params do not satisfy ${trigger.source.kind}: ${issues(params.error.issues)}`,
      repair: `fix ${at}.source in jigs.config.ts`,
    };
  }
  const clash = Object.keys(trigger.inputs ?? {}).filter((key) => key in source.sampleInputs);
  if (clash.length > 0) {
    return {
      reason: `inputs ${clash.join(", ")} ${clash.length === 1 ? "is" : "are"} also provided by the ${trigger.source.kind} source for each occurrence`,
      repair: `remove ${clash.join(", ")} from ${at}.inputs in jigs.config.ts\nthe source sets ${clash.length === 1 ? "it" : "them"} for each occurrence`,
    };
  }
  const inputs = entry.inputs.safeParse({ ...trigger.inputs, ...source.sampleInputs });
  if (!inputs.success) {
    return {
      reason: `the ${trigger.workflow} workflow does not accept what this trigger hands it: ${issues(inputs.error.issues)}`,
      repair: `make the ${trigger.workflow} workflow's inputs accept ${Object.keys(source.sampleInputs).join(", ") || "no fields"} from the ${trigger.source.kind} source, and fix ${at}.inputs in jigs.config.ts to supply the rest`,
    };
  }
  const workflowName = (entry.workflow as { workflowId?: string }).workflowId;
  return {
    name,
    trigger,
    source,
    params: params.data,
    maxActive: trigger.maxActive ?? DEFAULT_MAX_ACTIVE,
    lookbackMinutes: trigger.lookbackMinutes ?? DEFAULT_LOOKBACK_MINUTES,
    workflowName,
  };
}
