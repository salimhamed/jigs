import type { Check, CheckResult } from "../checks/check.ts";
import type { FactoryContext } from "../config/factory-context.ts";
import {
  missingWebhookSecret,
  webhookSecret,
  webhookSecretRepair,
} from "../config/webhook-secret.ts";
import type { FactoryConfig, ResolvedGithubIdentity } from "../workflow/factory-schema.ts";
import { githubAuthFor } from "./github-auth.ts";
import { GitHubApiError } from "./github-http.ts";
import { inspectRepoWebhook, parseGithubRemote } from "./github-webhook.ts";

export interface WebhookChecksOptions {
  context: FactoryContext;
  identity?: () => ResolvedGithubIdentity;
}

export function webhookChecks(options: WebhookChecksOptions): Check[] {
  const ctx = options.context;
  let config: FactoryConfig;
  try {
    config = ctx.config;
  } catch {
    // The binding checks own config diagnostics; do not duplicate them.
    return [];
  }
  // Off, there is no repo webhook to have: PR waits are polled instead.
  if (config.webhooks === undefined || !config.webhooks.github.enabled) return [];
  const webhooksUrl = config.webhooks.url;
  const secretCheck: Check = {
    id: "webhook.secret",
    label: "GitHub webhook secret",
    run: async () => {
      return webhookSecret("github", ctx) !== undefined
        ? { ok: true }
        : {
            ok: false,
            reason: `webhooks.github is enabled but ${missingWebhookSecret("github", ctx.root)}`,
            repair: `${webhookSecretRepair("github", ctx.root)}\nthen bind each repo again: \`pnpm exec jigs bind <remote-url>\``,
          };
    },
  };
  return [
    secretCheck,
    ...Object.entries(config.bindings).flatMap(([name, binding]) => {
      const repo = parseGithubRemote(binding.remote);
      return repo === null
        ? []
        : [
            {
              id: `webhook.${name}`,
              label: `webhook ${name}`,
              run: () =>
                checkWebhook(
                  ctx,
                  binding.remote,
                  webhooksUrl,
                  repo,
                  options.identity ?? (() => githubAuthFor(repo.owner, ctx).identity),
                ),
            },
          ];
    }),
  ];
}

// Hook administration is its own permission, and which one depends on the
// identity: a classic PAT needs `admin:repo_hook`, an App needs "Repository
// webhooks: read & write" granted and accepted on the installation.
function hookPermissionRepair(
  repo: { owner: string; repo: string },
  identity: ResolvedGithubIdentity,
  status: number,
): string {
  if (identity.mode !== "app")
    return `set GITHUB_TOKEN in the factory repo's .env to a classic PAT with admin:repo_hook on ${repo.owner}/${repo.repo}`;
  return status === 404
    ? `install the App on ${repo.owner}/${repo.repo} or grant its installation access to the repo, then grant "Repository webhooks: read & write" and accept the updated permissions`
    : `grant the App "Repository webhooks: read & write" and accept the updated permissions on its installation for ${repo.owner}/${repo.repo}`;
}

async function checkWebhook(
  context: FactoryContext,
  remote: string,
  webhooksUrl: string,
  repo: { owner: string; repo: string },
  resolveIdentity: () => ResolvedGithubIdentity,
): Promise<CheckResult> {
  const bindRepair = `bind it again: \`pnpm exec jigs bind ${remote}\``;
  try {
    const hook = await inspectRepoWebhook({ ...repo, webhooksUrl, context });
    if (hook.state === "ok") return { ok: true };
    if (hook.state === "missing") {
      return {
        ok: false,
        reason:
          "the repo has no active webhook at this factory's webhooks.url with the current events",
        repair: bindRepair,
      };
    }
    const latest = hook.count === 1 ? "delivery" : `${hook.count} deliveries`;
    return {
      ok: false,
      reason: `the factory rejected the hook's latest ${latest} with 401: GitHub's copy of the signing secret does not match GITHUB_WEBHOOK_SECRET in this factory's .env`,
      repair: bindRepair,
    };
  } catch (err) {
    if (err instanceof GitHubApiError && (err.status === 403 || err.status === 404)) {
      return {
        ok: false,
        reason: `GitHub refused the repo hooks request (${err.status})`,
        repair: hookPermissionRepair(repo, resolveIdentity(), err.status),
      };
    }
    throw err;
  }
}
