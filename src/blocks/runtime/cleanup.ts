import type { RunResource } from "./resources.ts";

export const CLEANUP_DIRECTIVE_ATTRIBUTE = "$jigs.cleanup.v1.directive";
export const CLEANUP_STATE_ATTRIBUTE = "$jigs.cleanup.v1.state";

export type CleanupAction = "keep" | "release";
export type CleanupOutcome = "success" | "failure";
export type CleanupStatus = "waiting" | "pending" | "running" | "kept" | "complete" | "failed";

export interface CleanupProgress {
  status: CleanupStatus;
  outcome?: CleanupOutcome;
  action?: CleanupAction;
  released?: number;
  kept?: number;
  failed?: number;
  unknown?: number;
  detail?: string;
}

export interface CleanupView extends CleanupProgress {
  directive: "automatic" | CleanupAction;
}

const encoder = new TextEncoder();
const MAX_VALUE_BYTES = 256;

export function encodeCleanupProgress(progress: CleanupProgress): string {
  let value = JSON.stringify(progress);
  if (encoder.encode(value).length <= MAX_VALUE_BYTES) return value;
  const withoutDetail = { ...progress, detail: undefined };
  value = JSON.stringify(withoutDetail);
  if (encoder.encode(value).length > MAX_VALUE_BYTES) {
    throw new Error("cleanup progress exceeds the run attribute value limit");
  }
  return value;
}

export function cleanupFromAttributes(
  attributes: Readonly<Record<string, string>> | undefined,
): CleanupView {
  const directive = attributes?.[CLEANUP_DIRECTIVE_ATTRIBUTE];
  const progress = decodeProgress(attributes?.[CLEANUP_STATE_ATTRIBUTE]);
  return {
    directive: directive === "keep" || directive === "release" ? directive : "automatic",
    ...progress,
  };
}

export function unknownResourceCount(resources: readonly RunResource[]): number {
  return resources.filter(
    (resource) => resource.kind !== "worktree" && resource.kind !== "run-directory",
  ).length;
}

function decodeProgress(value: string | undefined): CleanupProgress {
  if (value === undefined) return { status: "waiting" };
  try {
    const parsed = JSON.parse(value) as Partial<CleanupProgress>;
    if (
      parsed.status === "waiting" ||
      parsed.status === "pending" ||
      parsed.status === "running" ||
      parsed.status === "kept" ||
      parsed.status === "complete" ||
      parsed.status === "failed"
    ) {
      return parsed as CleanupProgress;
    }
  } catch {
    // A malformed reserved value is visible as a failed cleanup rather than
    // making the run itself uninspectable.
  }
  return { status: "failed", detail: "cleanup progress attribute is malformed" };
}
