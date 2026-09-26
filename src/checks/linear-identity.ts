import { FACTORY_CONFIG_FILE, type LinearIdentity } from "../config/factory-config.ts";
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

/** The Linear lookups the operator check makes. */
export interface LinearOperatorProbes {
  viewer(): Promise<LinearUser>;
  userByEmail(email: string): Promise<LinearUser | null>;
}

/** Where an operator email is configured: the factory, or one workflow's override. */
export interface OperatorSetting {
  email: string;
  workflow?: string;
}

// Doctor only, never preflight: a mention must never stop a run from starting.
/** Whether each configured operator email belongs to a Linear user who will be notified. */
export function linearOperatorChecks(
  identity: LinearIdentity,
  settings: OperatorSetting[],
  probes: LinearOperatorProbes,
): Check[] {
  return settings.map(({ email, workflow }) => {
    const where =
      workflow === undefined
        ? `linear.operator in ${FACTORY_CONFIG_FILE}`
        : `linear.operator in workflow ${workflow}'s defineWorkflow`;
    return {
      id: workflow === undefined ? "linear.operator" : `linear.operator.${workflow}`,
      label: workflow === undefined ? "Linear operator" : `Linear operator (workflow ${workflow})`,
      run: async () => {
        let user: LinearUser | null;
        try {
          user = await probes.userByEmail(email);
        } catch (err) {
          return {
            ok: false,
            reason: `could not look up ${email} in Linear: ${err}`,
            repair: "repair the Linear identity check, then: pnpm exec jigs doctor",
          };
        }
        if (user === null) {
          return {
            ok: false,
            reason: `no active Linear user has the email ${email}`,
            repair: `set ${where} to the email of an active user in this Linear workspace, or remove it to mention the ticket's creator, then: pnpm exec jigs up`,
          };
        }
        if (identity.mode === "key") {
          const viewer = await probes.viewer().catch(() => null);
          if (viewer?.id === user.id) {
            return {
              ok: true,
              detail: `${user.name} — warning: LINEAR_API_KEY belongs to ${user.name}, so jigs posts as them and Linear will not notify them of their own comments. Set linear.identity to { mode: "app" } in ${FACTORY_CONFIG_FILE} so jigs posts as itself`,
            };
          }
        }
        return { ok: true, detail: `mentions ${user.name}` };
      },
    };
  });
}
