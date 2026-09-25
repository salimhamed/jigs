// Which GitHub identity this factory runs as, and whether that credential
// actually works. The two modes fail in completely different ways — a rejected
// token versus an App whose key, installation or permissions are wrong — so
// each gets its own checks and its own repair.

import type { AppIdentity, GithubIdentity, ResolvedAppIdentity } from "../config/factory-config.ts";
import {
  fetchAppInstallation,
  fetchAppRegistration,
  readAppPrivateKey,
} from "../providers/github-auth.ts";
import type { Check, CheckResult } from "./catalog.ts";
import { RESTART_SERVICE, SERVICE_ENV_FILE } from "./core.ts";

// What jigs needs of an installation, and why.
interface RequiredPermission {
  name: string;
  level: "read" | "write";
  why: string;
}

const REQUIRED_PERMISSIONS: RequiredPermission[] = [
  { name: "contents", level: "write", why: "push the reviewed commit" },
  { name: "pull_requests", level: "write", why: "open, comment on and merge pull requests" },
  {
    name: "issues",
    level: "write",
    why: "post on the pull request conversation and create jigs' labels",
  },
  { name: "metadata", level: "read", why: "read the repository" },
  { name: "checks", level: "read", why: "read CI check runs while polling pull requests" },
  { name: "statuses", level: "read", why: "read CI commit statuses while polling pull requests" },
];

// Only with GitHub webhooks on, and then the one operators miss: `jigs bind`
// creates the per-repo webhook, and no other credential can do it.
const WEBHOOK_PERMISSIONS: RequiredPermission[] = [
  { name: "repository_hooks", level: "write", why: "create the webhook that wakes parked runs" },
];

const SATISFIES: Record<string, string[]> = { read: ["read", "write"], write: ["write"] };

export interface GithubIdentityProbes {
  whoami(): Promise<{ login: string }>;
  readPrivateKey(file: string): ReturnType<typeof readAppPrivateKey>;
  installation(
    identity: ResolvedAppIdentity,
    key: string,
  ): Promise<{ permissions: Record<string, string> }>;
  registration(identity: AppIdentity, key: string): Promise<{ slug: string }>;
}

export const realGithubIdentityProbes = (
  whoami: () => Promise<{ login: string }>,
): GithubIdentityProbes => ({
  whoami,
  readPrivateKey: readAppPrivateKey,
  installation: (identity, key) => fetchAppInstallation(identity, key),
  registration: (identity, key) => fetchAppRegistration(identity, key),
});

/** What else the identity checks need to know about the factory. */
export interface GithubIdentityCheckOptions {
  /** Whether GitHub webhooks are on, which makes an App need hook administration. */
  webhooks?: boolean;
}

/** The identity check for each configured identity. */
export function githubIdentityChecks(
  identities: GithubIdentity[],
  probes: GithubIdentityProbes,
  env: NodeJS.ProcessEnv = process.env,
  { webhooks = false }: GithubIdentityCheckOptions = {},
): Check[] {
  const registrations = new Map<number, Promise<{ slug: string }>>();
  const appProbes: GithubIdentityProbes = {
    ...probes,
    registration: (entry, key) => {
      let pending = registrations.get(entry.appId);
      if (!pending) {
        pending = probes.registration(entry, key);
        registrations.set(entry.appId, pending);
      }
      return pending;
    },
  };
  return identities.map((entry, index) => {
    const check =
      entry.mode === "pat" ? patCheck(probes, env) : appCheck(entry, webhooks, appProbes);
    return identities.length === 1
      ? check
      : { ...check, id: `github.identity.${index}`, label: `GitHub identity ${index + 1}` };
  });
}

function patCheck(probes: GithubIdentityProbes, env: NodeJS.ProcessEnv): Check {
  return {
    id: "github.identity",
    label: "GitHub identity",
    run: async (): Promise<CheckResult> => {
      const token = env.GITHUB_TOKEN;
      if (token === undefined || token === "") {
        return {
          ok: false,
          reason:
            "github.identities uses pat but GITHUB_TOKEN is not set in the service's environment",
          repair: `set GITHUB_TOKEN in ${SERVICE_ENV_FILE}, then: ${RESTART_SERVICE}`,
        };
      }
      try {
        const { login } = await probes.whoami();
        return { ok: true, detail: `jigs acts as ${login}` };
      } catch (err) {
        return {
          ok: false,
          reason: `GITHUB_TOKEN is set but GitHub rejected it: ${err}`,
          repair: `re-issue the token and update GITHUB_TOKEN in ${SERVICE_ENV_FILE}, then: ${RESTART_SERVICE}`,
        };
      }
    },
  };
}

function appCheck(identity: AppIdentity, webhooks: boolean, probes: GithubIdentityProbes): Check {
  return {
    id: "github.identity",
    label: "GitHub identity",
    run: async (): Promise<CheckResult> => {
      let key: string;
      let looseMode: string | undefined;
      try {
        ({ key, looseMode } = probes.readPrivateKey(identity.privateKeyPath));
      } catch (err) {
        return {
          ok: false,
          reason: String(err),
          repair: `download App ${identity.appId}’s private key, set privateKeyPath in that App’s entry in jigs.config.ts, and: chmod 600 ${identity.privateKeyPath}`,
        };
      }
      // Before any network call: a key anyone can read is a credential to
      // rotate, and probing with it first would only widen the window.
      if (looseMode !== undefined) {
        return {
          ok: false,
          reason: `${identity.privateKeyPath} is mode ${looseMode} — anyone on this machine can act as the App`,
          repair: `chmod 600 ${identity.privateKeyPath}`,
        };
      }
      const { installations: accountInstallations, ...app } = identity;
      const installationIds = Object.values(accountInstallations);
      let installations: Array<{ installationId: number; permissions: Record<string, string> }>;
      let slug: string;
      try {
        // Both mint a JWT from the key, so a key the App does not recognise
        // and an installation that is gone are distinguished by the message.
        [installations, { slug }] = await Promise.all([
          Promise.all(
            installationIds.map(async (installationId) => {
              try {
                return {
                  installationId,
                  ...(await probes.installation({ ...app, installationId }, key)),
                };
              } catch (err) {
                throw new Error(`installation ${installationId}: ${err}`);
              }
            }),
          ),
          probes.registration(identity, key),
        ]);
      } catch (err) {
        return {
          ok: false,
          reason: `App ${identity.appId} installation ${installationIds.join(", ")} did not answer: ${err}`,
          repair:
            "check the App entry’s appId and installations against the App's settings page and its installation, and that the private key belongs to that App",
        };
      }
      const requiredPermissions = [
        ...REQUIRED_PERMISSIONS,
        ...(webhooks ? WEBHOOK_PERMISSIONS : []),
      ];
      const missing = installations.flatMap(({ installationId, permissions }) =>
        requiredPermissions
          .filter(
            (required) =>
              !(SATISFIES[required.level] ?? []).includes(permissions[required.name] ?? "none"),
          )
          .map((permission) => ({
            ...permission,
            installationId,
          })),
      );
      if (missing.length > 0) {
        return {
          ok: false,
          reason: `the installation is missing ${missing.map((p) => `${p.name}: ${p.level} (to ${p.why}; installation ${p.installationId})`).join(", ")}`,
          repair: `grant the permission on the App (Settings → Developer settings → GitHub Apps → Permissions${missing.some((p) => p.name === "repository_hooks") ? " — “Repository webhooks” is Read & write" : ""}), then accept the updated permissions on the installation`,
        };
      }
      return {
        ok: true,
        detail: `jigs acts as ${slug}[bot] on ${Object.keys(identity.installations).join(", ")}; operator ${identity.operator}`,
      };
    },
  };
}
