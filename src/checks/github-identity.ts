// Which GitHub identity this factory runs as, and whether that credential
// actually works. The two modes fail in completely different ways — a rejected
// token versus an App whose key, installation or permissions are wrong — so
// each gets its own checks and its own repair.

import type { AppIdentity, GithubIdentity, MergePolicy } from "../config/factory-config.ts";
import {
  fetchAppInstallation,
  fetchAppRegistration,
  readAppPrivateKey,
} from "../providers/github-auth.ts";
import type { Check, CheckResult } from "./catalog.ts";
import { RESTART_SERVICE, SERVICE_ENV_FILE } from "./core.ts";

// What jigs needs of an installation, and why. `repository_hooks` is the one
// operators miss: `jigs bind` creates the per-repo webhook that wakes every
// parked pull request run, and no other credential is available to do it.
const REQUIRED_PERMISSIONS: Array<{ name: string; level: "read" | "write"; why: string }> = [
  { name: "contents", level: "write", why: "push the reviewed commit" },
  { name: "pull_requests", level: "write", why: "open, comment on and merge pull requests" },
  { name: "issues", level: "write", why: "post on the pull request conversation" },
  { name: "metadata", level: "read", why: "read the repository" },
  { name: "repository_hooks", level: "write", why: "create the webhook that wakes parked runs" },
];

const SATISFIES: Record<string, string[]> = { read: ["read", "write"], write: ["write"] };

export interface GithubIdentityProbes {
  whoami(): Promise<{ login: string }>;
  readPrivateKey(file: string): ReturnType<typeof readAppPrivateKey>;
  installation(
    identity: AppIdentity,
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

/** The identity check for the configured mode, plus the effective merge policy. */
export function githubIdentityChecks(
  identity: GithubIdentity,
  merge: MergePolicy,
  probes: GithubIdentityProbes,
  env: NodeJS.ProcessEnv = process.env,
): Check[] {
  return [
    identity.mode === "pat" ? patCheck(probes, env) : appCheck(identity, probes),
    mergePolicyCheck(merge),
  ];
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
          reason: "github.identity is pat but GITHUB_TOKEN is not set in the service's environment",
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

function appCheck(identity: AppIdentity, probes: GithubIdentityProbes): Check {
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
          repair: `download the App's private key, point github.identity.privateKeyPath at it, and: chmod 600 ${identity.privateKeyPath}`,
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
      let permissions: Record<string, string>;
      let slug: string;
      try {
        // Both mint a JWT from the key, so a key the App does not recognise
        // and an installation that is gone are distinguished by the message.
        [{ permissions }, { slug }] = await Promise.all([
          probes.installation(identity, key),
          probes.registration(identity, key),
        ]);
      } catch (err) {
        return {
          ok: false,
          reason: `App ${identity.appId} installation ${identity.installationId} did not answer: ${err}`,
          repair:
            "check github.identity.appId and installationId against the App's settings page and its installation, and that the private key belongs to that App",
        };
      }
      const missing = REQUIRED_PERMISSIONS.filter(
        (required) =>
          !(SATISFIES[required.level] ?? []).includes(permissions[required.name] ?? "none"),
      );
      if (missing.length > 0) {
        return {
          ok: false,
          reason: `the installation is missing ${missing.map((p) => `${p.name}: ${p.level} (to ${p.why})`).join(", ")}`,
          repair:
            "grant the permission on the App (Settings → Developer settings → GitHub Apps → Permissions — “Repository webhooks” is Read & write), then accept the updated permissions on the installation",
        };
      }
      return { ok: true, detail: `jigs acts as ${slug}[bot]; operator ${identity.operator}` };
    },
  };
}

// Not a probe: the one line that tells an operator what the factory will
// actually do when a pull request goes green, without reading the config.
function mergePolicyCheck(merge: MergePolicy): Check {
  const signal =
    merge.approval.kind === "review"
      ? "an approving GitHub review of the current commit"
      : `the ${merge.approval.name} label`;
  const who =
    merge.by === "jigs"
      ? `jigs merges with ${merge.method} once GitHub reports it mergeable and ${signal} is present`
      : `a human merges; jigs only watches (${signal} would be the signal if merge.by were jigs)`;
  return {
    id: "github.merge-policy",
    label: "merge policy",
    run: async (): Promise<CheckResult> => ({ ok: true, detail: who }),
  };
}
