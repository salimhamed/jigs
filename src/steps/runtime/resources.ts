import { getWorkflowMetadata, setAttributes } from "workflow";
import { getWorld } from "workflow/runtime";
import { JigsError } from "../../errors.ts";
import {
  RESOURCE_ATTRIBUTE_PREFIX,
  RUN_ATTRIBUTE_COUNT_LIMIT,
  type RunResource,
  resourceAttribute,
} from "../../workflow/runtime/resources.ts";

interface ResourceRegistrationDependencies {
  readAttributes: () => Promise<Record<string, string>>;
  writeAttribute: (key: string, value: string) => Promise<void>;
}

function registrationFailure(resource: RunResource, detail: string): JigsError {
  return new JigsError(
    `could not register ${resource.kind} ${JSON.stringify(resource.identity)}: ${detail}`,
    "the resource may already exist; retry registration separately instead of recreating it",
  );
}

function capacityFailure(resource: RunResource, attributes: Record<string, string>): JigsError {
  const keys = Object.keys(attributes);
  const resources = keys.filter((key) => key.startsWith(RESOURCE_ATTRIBUTE_PREFIX)).length;
  const otherReserved = keys.filter(
    (key) => key.startsWith("$") && !key.startsWith(RESOURCE_ATTRIBUTE_PREFIX),
  ).length;
  const user = keys.length - resources - otherReserved;
  return registrationFailure(
    resource,
    `the run already uses ${keys.length}/${RUN_ATTRIBUTE_COUNT_LIMIT} attributes (${resources} jigs resources, ${otherReserved} other reserved, ${user} user); the SDK has no free attribute key`,
  );
}

/**
 * The implementation behind the public durable registration step.
 *
 * Kept separate for tests: the production adapter below is the only place
 * that knows how to find the active run or invoke the Workflow SDK.
 */
export async function registerResourceWith(
  resource: RunResource,
  deps: ResourceRegistrationDependencies,
): Promise<RunResource> {
  const { key, value } = resourceAttribute(resource);
  const before = await deps.readAttributes();
  if (before[key] === value) return resource;
  if (!(key in before) && Object.keys(before).length >= RUN_ATTRIBUTE_COUNT_LIMIT) {
    throw capacityFailure(resource, before);
  }

  try {
    await deps.writeAttribute(key, value);
  } catch (error) {
    // A transport can fail after the World committed the write. Reading the
    // exact value makes that ambiguous outcome an idempotent success.
    const after = await deps.readAttributes().catch(() => undefined);
    if (after?.[key] === value) return resource;
    if (
      after !== undefined &&
      !(key in after) &&
      Object.keys(after).length >= RUN_ATTRIBUTE_COUNT_LIMIT
    ) {
      throw capacityFailure(resource, after);
    }
    throw registrationFailure(resource, error instanceof Error ? error.message : String(error));
  }
  return resource;
}

/**
 * Register one resource on the active run.
 *
 * Repeating kind + identity is idempotent. A new URL for that identity
 * replaces the old URL; concurrent updates are last-committed-wins. Distinct
 * identities occupy distinct atomic keys.
 *
 * @group Recorded resources
 */
export async function registerResource(resource: RunResource): Promise<RunResource> {
  const runId = getWorkflowMetadata().workflowRunId;
  const readAttributes = async () => {
    const run = await (await getWorld()).runs.get(runId, { resolveData: "none" });
    return { ...(run.attributes ?? {}) };
  };
  return registerResourceWith(resource, {
    readAttributes,
    writeAttribute: async (key, value) => {
      await setAttributes({ [key]: value }, { allowReservedAttributes: true });
    },
  });
}
