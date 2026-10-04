import { JigsError } from "../errors.ts";
import { driverFor } from "../steps/agents/shared/drivers.ts";
import {
  type HarnessRuntime,
  type HarnessRuntimeDeps,
  harnessRuntime,
} from "../steps/agents/shared/harness-runtime.ts";
import type {
  AskableModelSource,
  Harness,
  HarnessKind,
} from "../workflow/agents/harness-config.ts";
import { neededByUsers, requirementUsers, type WorkflowManifests } from "./catalog.ts";
import { type Check, failedCheck } from "./check.ts";
import type { WorkflowRequires } from "./index.ts";

/** Probe each harness CLI once, as the service's startup gate does. */
export function harnessRuntimes(
  kinds: HarnessKind[],
  deps: HarnessRuntimeDeps = {},
): Promise<HarnessRuntime[]> {
  return Promise.all([...new Set(kinds)].map((kind) => harnessRuntime(driverFor(kind), deps)));
}

/** The harness kinds a workflow's `requires.agents` runs. */
export function requiredHarnessKinds(requires: WorkflowRequires): HarnessKind[] {
  return Object.values(requires.agents ?? {}).map((agent) => agent.kind);
}

/** Map each harness kind a workflow's agents run to the workflows that run it. */
export function harnessUsers(workflows: WorkflowManifests): Map<HarnessKind, string[]> {
  return requirementUsers(workflows, requiredHarnessKinds);
}

type Descriptor = Harness | AskableModelSource;

// A descriptor its driver cannot plan fails as one check, the way the step would.
function checksFor(descriptor: Descriptor): Check[] {
  const driver = driverFor(descriptor.kind);
  let planned: Check[];
  try {
    planned = driver.descriptorChecks(descriptor);
  } catch (err) {
    planned = [
      failedCheck(
        `descriptor.${descriptor.kind}`,
        `${driver.displayName} descriptor`,
        err instanceof Error ? err.message : String(err),
        err instanceof JigsError && err.hint !== undefined
          ? err.hint
          : "fix the descriptor in the workflow's requires",
      ),
    ];
  }
  return [...driver.installationChecks(), ...planned];
}

/** The installation and descriptor checks of every harness and model source, each check id once. */
export function descriptorChecks(descriptors: readonly Descriptor[]): Check[] {
  const checks = new Map<string, Check>();
  for (const check of descriptors.flatMap(checksFor))
    if (!checks.has(check.id)) checks.set(check.id, check);
  return [...checks.values()];
}

/** The agents and model sources a workflow declares. */
export function requiredDescriptors(requires: WorkflowRequires): Descriptor[] {
  return [...Object.values(requires.agents ?? {}), ...(requires.models ?? [])];
}

/** The checks of every declared agent and model source, each failure naming the workflows that need it. */
export function usedDescriptorChecks(workflows: WorkflowManifests): Check[] {
  const users = new Map<string, { check: Check; workflows: string[] }>();
  for (const [workflow, { requires }] of Object.entries(workflows)) {
    for (const check of descriptorChecks(requiredDescriptors(requires ?? {}))) {
      const entry = users.get(check.id) ?? { check, workflows: [] };
      entry.workflows.push(workflow);
      users.set(check.id, entry);
    }
  }
  return [...users.values()].flatMap(({ check, workflows }) => neededByUsers([check], workflows));
}
