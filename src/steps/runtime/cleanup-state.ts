import { getWorld } from "workflow/runtime";
import {
  CLEANUP_DIRECTIVE_ATTRIBUTE,
  CLEANUP_STATE_ATTRIBUTE,
  type CleanupAction,
  type CleanupProgress,
  encodeCleanupProgress,
} from "../../blocks/runtime/cleanup.ts";

export interface CleanupAttributeStore {
  write(runId: string, changes: Array<{ key: string; value: string }>): Promise<void>;
}

export const worldCleanupAttributeStore = (): CleanupAttributeStore => ({
  write: async (runId, changes) => {
    const setter = (await getWorld()).runs.experimentalSetAttributes;
    if (setter === undefined) throw new Error("the configured World cannot persist cleanup state");
    await setter(runId, changes, { allowReservedAttributes: true });
  },
});

export async function writeCleanupDirective(
  runId: string,
  action: CleanupAction,
  store: CleanupAttributeStore = worldCleanupAttributeStore(),
): Promise<void> {
  await store.write(runId, [{ key: CLEANUP_DIRECTIVE_ATTRIBUTE, value: action }]);
}

export async function writeCleanupProgress(
  runId: string,
  progress: CleanupProgress,
  store: CleanupAttributeStore = worldCleanupAttributeStore(),
): Promise<void> {
  await store.write(runId, [
    { key: CLEANUP_STATE_ATTRIBUTE, value: encodeCleanupProgress(progress) },
  ]);
}
