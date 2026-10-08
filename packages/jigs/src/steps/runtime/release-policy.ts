import { currentFactoryContext } from "../../config/factory-context.ts";
import type { Factory } from "../../workflow/factory.ts";
import {
  defaultReleasePolicy,
  type ReleasePolicy,
  releaseSchema,
} from "../../workflow/runtime/release.ts";
import type { NamedRunMetadata } from "./run-context.ts";

/** Match the compiled ID the SDK records, not the factory's friendly key. */
export function workflowReleasePolicy(
  factory: Factory,
  workflowName: string,
): ReleasePolicy | undefined {
  return Object.values(factory.workflows).find(
    (entry) => (entry.workflow as { workflowId?: string }).workflowId === workflowName,
  )?.release;
}

export function effectiveReleasePolicy(
  workflow?: ReleasePolicy,
  factory?: ReleasePolicy,
): ReleasePolicy {
  return releaseSchema.parse(workflow ?? factory ?? defaultReleasePolicy());
}

/** Resolve the workflow policy, then the factory policy, then the built-in release/keep default. */
export async function resolveReleasePolicy(metadata: NamedRunMetadata): Promise<ReleasePolicy> {
  const { config } = currentFactoryContext();
  const workflows = Object.fromEntries(
    await Promise.all(
      Object.entries(config.workflows ?? {}).map(async ([name, load]) => [
        name,
        (await load()).default,
      ]),
    ),
  );
  return effectiveReleasePolicy(
    workflowReleasePolicy({ workflows }, metadata.workflowName),
    config.release,
  );
}
