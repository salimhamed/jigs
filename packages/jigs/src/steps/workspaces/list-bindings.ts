import { currentFactoryContext } from "../../config/factory-context.ts";
import { parseGithubRemote } from "../../providers/github-remote.ts";
import type { RepositoryRef } from "../../workflow/pull-requests/pull-request.ts";

/**
 * Every binding in the factory's configuration on GitHub, with the repository it points at.
 *
 * @group Worktrees
 */
export function listBindings(): Array<RepositoryRef & { name: string }> {
  const { bindings } = currentFactoryContext().config;
  return Object.entries(bindings).flatMap(([name, { remote, installationName }]) => {
    const repository = parseGithubRemote(remote);
    return repository === null ? [] : [{ name, installationName, ...repository }];
  });
}
