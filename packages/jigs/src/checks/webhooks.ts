import path from "node:path";
import {
  parseFactoryConfig,
  readFactoryConfigText,
} from "../config/factory-config.ts";
import { factoryEnvValue } from "../config/factory-env.ts";
import {
  GithubApiError,
  parseGithubRemote,
  verifyRepoWebhook,
} from "../github-webhook.ts";
import type { Check, CheckResult } from "./catalog.ts";

export interface WebhookChecksOptions {
  factoryRoot: () => string;
}

export function webhookChecks(options: WebhookChecksOptions): Check[] {
  let root: string;
  let config: ReturnType<typeof parseFactoryConfig>;
  try {
    root = options.factoryRoot();
    config = parseFactoryConfig(readFactoryConfigText(root));
  } catch {
    // The binding checks own config diagnostics; do not duplicate them.
    return [];
  }
  if (config.ingress_url === undefined) return [];
  const ingressUrl = config.ingress_url;
  return Object.entries(config.bindings).flatMap(([name, binding]) => {
    const repo = parseGithubRemote(binding.remote);
    return repo === null
      ? []
      : [
          {
            id: `webhook.${name}`,
            label: `webhook ${name}`,
            run: () => checkWebhook(root, binding.remote, ingressUrl, repo),
          },
        ];
  });
}

async function checkWebhook(
  factoryRoot: string,
  remote: string,
  ingressUrl: string,
  repo: { owner: string; repo: string },
): Promise<CheckResult> {
  const bindRepair = `run: jigs bind ${remote}`;
  const token = factoryEnvValue(factoryRoot, "GITHUB_TOKEN");
  const tokenRepair = `set GITHUB_TOKEN in ${path.join(factoryRoot, ".env")} to a classic PAT with admin:repo_hook on ${repo.owner}/${repo.repo}`;
  if (token === undefined) {
    return {
      ok: false,
      reason: "GITHUB_TOKEN is not set",
      repair: tokenRepair,
    };
  }
  try {
    return (await verifyRepoWebhook({ ...repo, ingressUrl, token }))
      ? { ok: true }
      : {
          ok: false,
          reason:
            "the repo has no active webhook at this factory's ingress URL with the current events",
          repair: bindRepair,
        };
  } catch (err) {
    if (
      err instanceof GithubApiError &&
      (err.status === 403 || err.status === 404)
    ) {
      return {
        ok: false,
        reason: `GitHub refused the repo hooks request (${err.status})`,
        repair: tokenRepair,
      };
    }
    throw err;
  }
}
