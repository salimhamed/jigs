import type { LinearIdentity } from "../config/factory-config.ts";
import type { LinearUser } from "../providers/linear.ts";
import {
  type EnvLookup,
  LINEAR_IDENTITY_VARIABLES,
  linearEnvValue,
  missingLinearVariables,
} from "../providers/linear-auth.ts";
import type { Check } from "./catalog.ts";
import { RESTART_SERVICE, SERVICE_ENV_FILE } from "./core.ts";

// A probe is a provider client; the catalog owns the repair text, which is
// what makes preflight and doctor say the same thing.
export interface LinearIdentityProbes {
  viewer(): Promise<LinearUser>;
}

const SOURCE: Record<LinearIdentity["mode"], string> = {
  key: "a Linear personal API key",
  app: "the Linear OAuth application's client id and secret, with client credentials enabled",
};

/** Whether the identity's credential is present, and whether Linear accepts it. */
export function linearIdentityChecks(
  identity: LinearIdentity,
  probes: LinearIdentityProbes,
  env: EnvLookup = linearEnvValue,
): Check[] {
  const { mode } = identity;
  const variables = LINEAR_IDENTITY_VARIABLES[mode].join(" and ");
  return [
    {
      id: "linear.identity",
      label: "Linear identity",
      run: async () => {
        const missing = missingLinearVariables(identity, env);
        if (missing.length > 0) {
          return {
            ok: false,
            reason: `linear.identity uses ${mode} but ${missing.join(" and ")} ${missing.length === 1 ? "is" : "are"} not set`,
            repair: `set ${variables} (${SOURCE[mode]}) in ${SERVICE_ENV_FILE}, then: ${RESTART_SERVICE}`,
          };
        }
        let viewer: LinearUser;
        try {
          viewer = await probes.viewer();
        } catch (err) {
          return {
            ok: false,
            reason: `${variables} ${mode === "key" ? "is" : "are"} set but Linear rejected ${mode === "key" ? "it" : "them"}: ${err}`,
            repair:
              mode === "key"
                ? `re-issue the key and update LINEAR_API_KEY in ${SERVICE_ENV_FILE}, then: ${RESTART_SERVICE}`
                : `check ${variables} in ${SERVICE_ENV_FILE} against the Linear OAuth application and that client credentials are enabled on it, then: ${RESTART_SERVICE}`,
          };
        }
        return {
          ok: true,
          detail: mode === "key" ? `acting as ${viewer.name}` : `acting as the app ${viewer.name}`,
        };
      },
    },
  ];
}
