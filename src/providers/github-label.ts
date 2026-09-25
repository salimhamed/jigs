import { APPROVED_LABEL } from "../workflow/pull-requests/policy.ts";
import { GithubApiError, githubGet, githubRequest } from "./github-api.ts";

/** A label jigs creates on every GitHub repository it is bound to. */
export interface JigsLabel {
  name: string;
  /** Six hex digits, without the leading `#`. */
  color: string;
  description: string;
}

/** Every label jigs relies on. `jigs bind` makes sure each one exists on the repository. */
export const JIGS_LABELS: readonly JigsLabel[] = [
  { name: APPROVED_LABEL, color: "1d76db", description: "Approves this pull request for jigs" },
];

export interface EnsureRepoLabelOptions {
  owner: string;
  repo: string;
  label: JigsLabel;
}

/** Create a repository label when absent, leaving an existing label untouched. */
export async function ensureRepoLabel({
  owner,
  repo,
  label,
}: EnsureRepoLabelOptions): Promise<"created" | "verified"> {
  const labelPath = `/repos/${owner}/${repo}/labels/${encodeURIComponent(label.name)}`;
  try {
    await githubGet(labelPath);
    return "verified";
  } catch (err) {
    if (!(err instanceof GithubApiError) || err.status !== 404) throw err;
  }

  await githubRequest("POST", `/repos/${owner}/${repo}/labels`, label);
  return "created";
}
