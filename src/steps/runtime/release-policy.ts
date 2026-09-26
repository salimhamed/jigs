import { readFactoryConfig } from "../../config/factory-config.ts";
import { factoryRoot } from "../../config/factory-root.ts";
import type { Factory, FactoryDefinition } from "../../workflow/factory.ts";
import {
  defaultReleasePolicy,
  type ReleasePolicy,
  releaseSchema,
} from "../../workflow/runtime/release.ts";
import type { NamedRunMetadata } from "./run-context.ts";
import { findRunWorkflow, loadRunWorkflow } from "./run-workflow.ts";

export function workflowReleasePolicy(
  factory: Factory,
  workflowName: string,
): ReleasePolicy | undefined {
  return findRunWorkflow(factory, workflowName)?.release;
}

export function effectiveReleasePolicy(
  workflow?: ReleasePolicy,
  factory?: ReleasePolicy,
): ReleasePolicy {
  return releaseSchema.parse(workflow ?? factory ?? defaultReleasePolicy());
}

/** Resolve the workflow policy, then the factory policy, then the built-in release/keep default. */
export async function resolveReleasePolicy(
  metadata: NamedRunMetadata,
  definition: FactoryDefinition,
): Promise<ReleasePolicy> {
  return effectiveReleasePolicy(
    (await loadRunWorkflow(metadata, definition))?.release,
    readFactoryConfig(factoryRoot()).release,
  );
}
