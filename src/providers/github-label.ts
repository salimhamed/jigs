import { GithubApiError, githubGet, githubRequest } from "./github-api.ts";

export interface EnsureRepoLabelOptions {
  owner: string;
  repo: string;
  name: string;
}

/** Create a repository label when absent, leaving an existing label untouched. */
export async function ensureRepoLabel({
  owner,
  repo,
  name,
}: EnsureRepoLabelOptions): Promise<"created" | "verified"> {
  const labelPath = `/repos/${owner}/${repo}/labels/${encodeURIComponent(name)}`;
  try {
    await githubGet(labelPath);
    return "verified";
  } catch (err) {
    if (!(err instanceof GithubApiError) || err.status !== 404) throw err;
  }

  await githubRequest("POST", `/repos/${owner}/${repo}/labels`, { name });
  return "created";
}
