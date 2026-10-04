// What makes a declared trigger or schedule runnable: the boot refuses one
// that fails, and doctor reports the same failure on demand.

import type { z } from "zod";
import type { EventTrigger, Factory } from "../../workflow/factory.ts";
import type { Source, SourceRegistry } from "./sources.ts";

const DEFAULT_MAX_ACTIVE = 20;
const DEFAULT_LOOKBACK_MINUTES = 60;

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

/** A name a run's trigger id cannot carry: the id is read back by splitting on the first ":". */
export function nameProblem(kind: "schedule" | "trigger", name: string): ConfigProblem | null {
  if (!name.includes(":")) return null;
  return {
    reason: `${kind} name "${name}" contains ":"`,
    repair: `rename the "${name}" ${kind} in jigs.config.ts to a name without ":"\na run's trigger id is read back out of the name`,
  };
}

/** A workflow name that is not one of the factory's, configured at `at` in jigs.config.ts. */
export function workflowProblem(
  factory: Factory,
  at: string,
  workflow: string,
): ConfigProblem | null {
  if (factory.workflows[workflow]) return null;
  return {
    reason: `workflow "${workflow}" is not one of this factory's workflows`,
    repair: `set ${at}.workflow in jigs.config.ts to one of: ${Object.keys(factory.workflows).join(", ")}`,
  };
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
  // The occurrence follows the name after a ":", and the trigger column reads
  // the name back by splitting on the first one.
  const problem = nameProblem("trigger", name) ?? workflowProblem(factory, at, trigger.workflow);
  if (problem !== null) return problem;
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
  const maxActive = trigger.maxActive ?? DEFAULT_MAX_ACTIVE;
  if (!Number.isInteger(maxActive) || maxActive < 1) {
    return {
      reason: `maxActive ${maxActive} is not a whole number of at least 1`,
      repair: `set ${at}.maxActive in jigs.config.ts to 1 or more, or remove it for the default of ${DEFAULT_MAX_ACTIVE}`,
    };
  }
  const lookbackMinutes = trigger.lookbackMinutes ?? DEFAULT_LOOKBACK_MINUTES;
  if (!Number.isFinite(lookbackMinutes) || lookbackMinutes <= 0) {
    return {
      reason: `lookbackMinutes ${lookbackMinutes} is not a positive number of minutes`,
      repair: `set ${at}.lookbackMinutes in jigs.config.ts above 0, or remove it for the default of ${DEFAULT_LOOKBACK_MINUTES}`,
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
  return { name, trigger, source, params: params.data, maxActive, lookbackMinutes, workflowName };
}
