import { readFactoryConfig } from "../config/factory-config.ts";
import { GithubApiError } from "../providers/github-api.ts";
import { resolveGithubIdentity } from "../providers/github-auth.ts";
import { parseGithubRemote, verifyRepoWebhook } from "../providers/github-webhook.ts";
import type { Check, CheckResult } from "./catalog.ts";

export interface WebhookChecksOptions {
  factoryRoot: () => string;
}

export function webhookChecks(options: WebhookChecksOptions): Check[] {
  let config: ReturnType<typeof readFactoryConfig>;
  try {
    config = readFactoryConfig(options.factoryRoot());
  } catch {
    // The binding checks own config diagnostics; do not duplicate them.
    return [];
  }
  if (config.ingressUrl === undefined) return [];
  const ingressUrl = config.ingressUrl;
  return Object.entries(config.bindings).flatMap(([name, binding]) => {
    const repo = parseGithubRemote(binding.remote);
    return repo === null
      ? []
      : [
          {
            id: `webhook.${name}`,
            label: `webhook ${name}`,
            run: () => checkWebhook(binding.remote, ingressUrl, repo),
          },
        ];
  });
}

// Hook administration is its own permission, and which one depends on the
// identity: a classic PAT needs `admin:repo_hook`, an App needs "Repository
// webhooks: read & write" granted and accepted on the installation.
function hookPermissionRepair(repo: { owner: string; repo: string }): string {
  return resolveGithubIdentity().mode === "app"
    ? `grant the App "Repository webhooks: read & write" and accept the updated permissions on its installation for ${repo.owner}/${repo.repo}`
    : `set GITHUB_TOKEN in the factory repo's .env to a classic PAT with admin:repo_hook on ${repo.owner}/${repo.repo}`;
}

async function checkWebhook(
  remote: string,
  ingressUrl: string,
  repo: { owner: string; repo: string },
): Promise<CheckResult> {
  const bindRepair = `run: jigs bind ${remote}`;
  try {
    return (await verifyRepoWebhook({ ...repo, ingressUrl }))
      ? { ok: true }
      : {
          ok: false,
          reason:
            "the repo has no active webhook at this factory's ingress URL with the current events",
          repair: bindRepair,
        };
  } catch (err) {
    if (err instanceof GithubApiError && (err.status === 403 || err.status === 404)) {
      return {
        ok: false,
        reason: `GitHub refused the repo hooks request (${err.status})`,
        repair: hookPermissionRepair(repo),
      };
    }
    throw err;
  }
}
