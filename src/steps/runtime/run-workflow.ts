import type { Factory, FactoryDefinition, WorkflowDefinition } from "../../workflow/factory.ts";
import type { NamedRunMetadata } from "./run-context.ts";

/** Match the compiled ID the SDK records, not the factory's friendly key. */
export function findRunWorkflow(
  factory: Pick<Factory, "workflows">,
  workflowName: string,
): WorkflowDefinition | undefined {
  return Object.values(factory.workflows).find(
    (entry) => (entry.workflow as { workflowId?: string }).workflowId === workflowName,
  );
}

/** Load the factory's deferred workflows and return the definition this run belongs to. */
export async function loadRunWorkflow(
  metadata: NamedRunMetadata,
  definition: FactoryDefinition,
): Promise<WorkflowDefinition | undefined> {
  const workflows = Object.fromEntries(
    await Promise.all(
      Object.entries(definition.workflows).map(async ([name, load]) => [
        name,
        (await load()).default,
      ]),
    ),
  );
  return findRunWorkflow({ workflows }, metadata.workflowName);
}
