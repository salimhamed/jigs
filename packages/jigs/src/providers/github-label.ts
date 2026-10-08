import type { FactoryContext } from "../config/factory-context.ts";
import { APPROVED_LABEL } from "../workflow/pull-requests/policy.ts";
import { githubGet, githubRequest } from "./github-api.ts";
import { GitHubApiError } from "./github-http.ts";

/** A label jigs creates on every GitHub repository it is bound to. */
export interface JigsLabel {
  name: string;
  /** Six hex digits, without the leading `#`. */
  color: string;
  description: string;
}

/** Every label jigs relies on. `jigs bind` makes sure each one exists on the repository. */
export const JIGS_LABELS: readonly JigsLabel[] = [
  { name: APPROVED_LABEL, color: "1d76db", description: "Approves this pull request for merging" },
];

export interface EnsureRepoLabelOptions {
  installationName: string;
  owner: string;
  repo: string;
  label: JigsLabel;
  context?: FactoryContext;
}

/** Create a repository label when absent, leaving an existing label untouched. */
export async function ensureRepoLabel({
  installationName,
  owner,
  repo,
  label,
  context,
}: EnsureRepoLabelOptions): Promise<"created" | "verified"> {
  const labelPath = `/repos/${owner}/${repo}/labels/${encodeURIComponent(label.name)}`;
  try {
    await githubGet(installationName, labelPath, context);
    return "verified";
  } catch (err) {
    if (!(err instanceof GitHubApiError) || err.status !== 404) throw err;
  }

  await githubRequest(installationName, "POST", `/repos/${owner}/${repo}/labels`, label, context);
  return "created";
}
