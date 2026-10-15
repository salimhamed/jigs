import { currentFactoryContext } from "../../config/factory-context.ts";
import { JigsError } from "../../errors.ts";
import { parseGithubRemote } from "../../providers/github-remote.ts";
import type { RepositoryRef } from "../../workflow/pull-requests/pull-request.ts";

/**
 * Every binding in the factory's configuration, with the GitHub repository it points at.
 *
 * @group Worktrees
 */
export function listBindings(): Array<RepositoryRef & { name: string }> {
  const { bindings } = currentFactoryContext().config;
  return Object.entries(bindings).map(([name, { remote, installationName }]) => {
    const repository = parseGithubRemote(remote);
    if (repository === null) {
      throw new JigsError(`binding ${name} points at ${remote}, which is not a github.com remote`);
    }
    return { name, installationName, ...repository };
  });
}
