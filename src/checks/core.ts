import type { Check, CheckResult } from "./catalog.ts";

// The service belongs to a factory repo, so its environment file is that
// repo's own .env and the restart is the CLI verb that supervises it — both
// stay correct for whichever factory raised the check, unlike the single
// global path and unit name they replace.
export const SERVICE_ENV_FILE = "the factory repo's .env";
export const RESTART_SERVICE = "jigs service restart";

// A probe is a provider client; the catalog owns the repair text, which is
// what makes preflight and doctor say the same thing.
export interface CoreProbes {
  linearViewer(): Promise<unknown>;
  githubWhoami(): Promise<unknown>;
}

interface CredentialCheck {
  id: string;
  label: string;
  variable: string;
  provider: string;
  probe: () => Promise<unknown>;
  env: NodeJS.ProcessEnv;
}

function credentialCheck(spec: CredentialCheck): Check {
  return {
    id: spec.id,
    label: spec.label,
    run: async (): Promise<CheckResult> => {
      const value = spec.env[spec.variable];
      if (value === undefined || value === "") {
        return {
          ok: false,
          reason: `${spec.variable} is not set in the service's environment`,
          repair: `set ${spec.variable} in ${SERVICE_ENV_FILE}, then: ${RESTART_SERVICE}`,
        };
      }
      try {
        await spec.probe();
      } catch (err) {
        return {
          ok: false,
          reason: `${spec.variable} is set but ${spec.provider} rejected it: ${err}`,
          repair: `re-issue the token and update ${spec.variable} in ${SERVICE_ENV_FILE}, then: ${RESTART_SERVICE}`,
        };
      }
      return { ok: true };
    },
  };
}

export function coreChecks(
  probes: CoreProbes,
  env: NodeJS.ProcessEnv = process.env,
): Check[] {
  return [
    credentialCheck({
      id: "core.linear-api-key",
      label: "Linear API key",
      variable: "LINEAR_API_KEY",
      provider: "Linear",
      probe: () => probes.linearViewer(),
      env,
    }),
    credentialCheck({
      id: "core.github-token",
      label: "GitHub token",
      variable: "GITHUB_TOKEN",
      provider: "GitHub",
      probe: () => probes.githubWhoami(),
      env,
    }),
  ];
}
