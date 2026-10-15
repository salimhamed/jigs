import { currentFactoryContext } from "../../config/factory-context.ts";
import { bindingRepository } from "../../workflow/github-remote.ts";
import type { RepositoryRef } from "../../workflow/pull-requests/pull-request.ts";

/**
 * Every binding in the factory's configuration, with the repository it points at.
 *
 * @group Worktrees
 */
export function listBindings(): Array<RepositoryRef & { name: string }> {
  const { bindings } = currentFactoryContext().config;
  return Object.entries(bindings).map(([name, { remote, installationName }]) => ({
    name,
    installationName,
    ...bindingRepository(remote),
  }));
}
