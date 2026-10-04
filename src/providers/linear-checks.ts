import { type Check, failedCheck } from "../checks/check.ts";
import {
  FACTORY_CONFIG_FILE,
  type LinearIdentity,
  readFactoryConfig,
} from "../config/factory-config.ts";
import { factoryRoot } from "../config/factory-root.ts";
import {
  credentialValue,
  type EnvLookup,
  RESTART_SERVICE,
  SERVICE_ENV_FILE,
} from "./credentials.ts";
import { findUserByEmail, getViewer, type LinearUser } from "./linear.ts";
import {
  LINEAR_IDENTITY_VARIABLES,
  missingLinearVariables,
  resolveLinearIdentity,
} from "./linear-auth.ts";

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
  env: EnvLookup = credentialValue,
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
            repair: `set ${variables} (${SOURCE[mode]}) in ${SERVICE_ENV_FILE}, then: \`${RESTART_SERVICE}\``,
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
                ? `re-issue the key and update LINEAR_API_KEY in ${SERVICE_ENV_FILE}, then: \`${RESTART_SERVICE}\``
                : `check ${variables} in ${SERVICE_ENV_FILE} against the Linear OAuth application and that client credentials are enabled on it, then: \`${RESTART_SERVICE}\``,
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

// Doctor only, never preflight: a mention must never stop a run from starting.
/** Whether the factory's operator email belongs to a Linear user who will be notified. */
export function linearOperatorChecks(
  identity: LinearIdentity,
  email: string | undefined,
  probes: LinearOperatorProbes,
): Check[] {
  if (email === undefined) return [];
  return [
    {
      id: "linear.operator",
      label: "Linear operator",
      run: async () => {
        let user: LinearUser | null;
        try {
          user = await probes.userByEmail(email);
        } catch (err) {
          return {
            ok: false,
            reason: `could not look up ${email} in Linear: ${err}`,
            repair: "repair the Linear identity check, then: `pnpm exec jigs doctor`",
          };
        }
        if (user === null) {
          return {
            ok: false,
            reason: `no active Linear user has the email ${email}`,
            repair: `set linear.operator in ${FACTORY_CONFIG_FILE} to the email of an active user in this Linear workspace, or remove it to mention the ticket's creator, then: \`pnpm exec jigs up\``,
          };
        }
        if (identity.mode === "key") {
          const viewer = await probes.viewer().catch(() => null);
          if (viewer?.id === user.id) {
            return {
              ok: true,
              detail: `mentions ${user.name}\nwarning: LINEAR_API_KEY belongs to ${user.name}, so jigs posts as them and Linear will not notify them of their own comments\nset linear.identity to { mode: "app" } in ${FACTORY_CONFIG_FILE} so jigs posts as itself`,
            };
          }
        }
        return { ok: true, detail: `mentions ${user.name}` };
      },
    },
  ];
}

// A configuration that cannot be read says nothing about the credential, so it
// fails as itself rather than as a key Linear rejected.
export function linearChecks(): Check[] {
  let identity: LinearIdentity;
  try {
    identity = resolveLinearIdentity();
  } catch (err) {
    return [
      failedCheck(
        "linear.identity",
        "Linear identity",
        err instanceof Error ? err.message : String(err),
        `repair ${FACTORY_CONFIG_FILE}, then: \`${RESTART_SERVICE}\``,
      ),
    ];
  }
  return linearIdentityChecks(identity, { viewer: getViewer });
}

// An unreadable config is the identity check's diagnosis, so it adds nothing here.
export function linearOperatorDoctorChecks(): Check[] {
  let identity: LinearIdentity;
  let operator: string | undefined;
  try {
    identity = resolveLinearIdentity();
    operator = readFactoryConfig(factoryRoot()).linear.operator;
  } catch {
    return [];
  }
  return linearOperatorChecks(identity, operator, {
    viewer: getViewer,
    userByEmail: findUserByEmail,
  });
}
