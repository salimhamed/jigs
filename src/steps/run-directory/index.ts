import { mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { jigsDataDir } from "../../config/paths.ts";
import type { RunMetadata } from "../run-context.ts";

export function runDirectory(metadata: RunMetadata): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(metadata.workflowRunId)) {
    throw new Error("Invalid workflow run ID for a run directory");
  }
  return path.join(jigsDataDir(), "scratch", metadata.workflowRunId);
}

/** Create a working directory that survives retries and pauses in this run. */
export async function createRunDirectory(metadata: RunMetadata): Promise<string> {
  const directory = runDirectory(metadata);
  await mkdir(directory, { recursive: true });
  return directory;
}

/** Remove this run's working directory after its work is finished, never while paused. */
export async function removeRunDirectory(metadata: RunMetadata): Promise<void> {
  await rm(runDirectory(metadata), { recursive: true, force: true });
}

/** Only direct real directories with valid run IDs are candidates for manual sweep. */
export async function listRunDirectories(): Promise<{ path: string; runId: string }[]> {
  const root = path.join(jigsDataDir(), "scratch");
  const entries = await readdir(root, { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    },
  );
  return entries
    .filter((entry) => entry.isDirectory() && /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(entry.name))
    .map((entry) => ({ path: runDirectory({ workflowRunId: entry.name }), runId: entry.name }));
}
