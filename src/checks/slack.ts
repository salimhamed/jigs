import type { SlackConfig } from "../config/factory-config.ts";
import {
  SLACK_BOT_SCOPES,
  SlackApiError,
  type SlackAuth,
  type SlackToken,
  slackEnvValue,
} from "../providers/slack.ts";
import type { Check } from "./catalog.ts";
import { RESTART_SERVICE, SERVICE_ENV_FILE } from "./core.ts";

/** The Slack calls the checks make. */
export interface SlackProbes {
  authTest(): Promise<SlackAuth>;
  openConnection(): Promise<string>;
}

type EnvLookup = (name: SlackToken) => string | undefined;

const APP_SETTINGS = "the Slack app's settings (api.slack.com/apps)";
const and = (items: readonly string[]) => items.join(" and ");

// The codes Slack gives a token it will not accept; anything else says nothing
// about the token.
const REJECTED_TOKEN = new Set(["invalid_auth", "not_authed", "token_revoked", "account_inactive"]);

const createAppToken = `create an app-level token with the connections:write scope under Basic Information → App-Level Tokens in ${APP_SETTINGS}`;

const SOCKET_MODE_FIX: Record<string, string> = {
  missing_scope: `an app-level token's scopes are fixed when it is made; ${createAppToken}`,
  not_allowed_token_type: `SLACK_APP_TOKEN must be an app-level token (xapp-), not the bot token; ${createAppToken}`,
};

/**
 * Whether the bot token is set, accepted by Slack and granted every scope jigs
 * uses, plus the factory's own `slack.scopes`.
 */
export function slackIdentityChecks(
  probes: SlackProbes,
  extraScopes: readonly string[] = [],
  env: EnvLookup = slackEnvValue,
): Check[] {
  const scopes = [...new Set([...SLACK_BOT_SCOPES, ...extraScopes])];
  return [
    {
      id: "slack.identity",
      label: "Slack identity",
      run: async () => {
        if (env("SLACK_BOT_TOKEN") === undefined) {
          return {
            ok: false,
            reason: "SLACK_BOT_TOKEN is not set",
            repair: `copy the Bot User OAuth Token (xoxb-) from OAuth & Permissions in ${APP_SETTINGS}, set it as SLACK_BOT_TOKEN in ${SERVICE_ENV_FILE}, then: \`${RESTART_SERVICE}\``,
          };
        }
        let auth: SlackAuth;
        try {
          auth = await probes.authTest();
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (err instanceof SlackApiError && REJECTED_TOKEN.has(err.code)) {
            return {
              ok: false,
              reason: `SLACK_BOT_TOKEN is set but Slack rejected it: ${message}`,
              repair: `copy the current Bot User OAuth Token from OAuth & Permissions in ${APP_SETTINGS} into SLACK_BOT_TOKEN in ${SERVICE_ENV_FILE}, installing the app first if it is not installed, then: \`${RESTART_SERVICE}\``,
            };
          }
          return {
            ok: false,
            reason: `Slack could not be reached: ${message}`,
            repair:
              "check that this machine can reach slack.com, then retry: `pnpm exec jigs doctor`",
          };
        }
        const granted = new Set(auth.scopes);
        const missing = scopes.filter((scope) => !granted.has(scope));
        if (missing.length > 0) {
          return {
            ok: false,
            reason: `the bot token lacks ${and(missing)}`,
            repair: `add ${and(missing)} to the Bot Token Scopes under OAuth & Permissions in ${APP_SETTINGS}, reinstall the app to the workspace, then: \`${RESTART_SERVICE}\``,
          };
        }
        return { ok: true, detail: `acting as @${auth.user} in ${auth.team}` };
      },
    },
  ];
}

// Doctor only: apps.connections.open is rate limited to about one call a
// minute, and the service's own connection needs that budget more than a
// per-run preflight does.
/** With Socket Mode on, whether the app-level token opens a connection. */
export function slackSocketModeChecks(
  slack: Pick<SlackConfig, "socketMode">,
  probes: SlackProbes,
  env: EnvLookup = slackEnvValue,
): Check[] {
  if (!slack.socketMode) return [];
  return [
    {
      id: "slack.socket-mode",
      label: "Slack Socket Mode",
      run: async () => {
        if (env("SLACK_APP_TOKEN") === undefined) {
          return {
            ok: false,
            reason: "slack.socketMode is on but SLACK_APP_TOKEN is not set",
            repair: `${createAppToken}, set it as SLACK_APP_TOKEN in ${SERVICE_ENV_FILE}, then: \`${RESTART_SERVICE}\``,
          };
        }
        try {
          await probes.openConnection();
          return { ok: true };
        } catch (err) {
          const reason = `SLACK_APP_TOKEN could not open a Socket Mode connection: ${err instanceof Error ? err.message : String(err)}`;
          const fix =
            (err instanceof SlackApiError ? SOCKET_MODE_FIX[err.code] : undefined) ??
            `turn on Socket Mode in ${APP_SETTINGS}; if the token was revoked, ${createAppToken}`;
          return {
            ok: false,
            reason,
            repair: `${fix}, set it as SLACK_APP_TOKEN in ${SERVICE_ENV_FILE}, then: \`${RESTART_SERVICE}\``,
          };
        }
      },
    },
  ];
}

/** The slugs of the other live services on this machine using the same Slack app. */
export type SlackAppHoldersProbe = () => readonly string[];

/**
 * With Socket Mode on, whether another service on this machine holds Socket
 * Mode connections for the same Slack app, which splits its events.
 */
export function slackSharedAppChecks(
  slack: Pick<SlackConfig, "socketMode">,
  otherHolders: SlackAppHoldersProbe,
  env: EnvLookup = slackEnvValue,
): Check[] {
  if (!slack.socketMode || env("SLACK_APP_TOKEN") === undefined) return [];
  return [
    {
      id: "slack.shared-app",
      label: "Slack app sharing",
      run: async () => {
        const others = otherHolders();
        if (others.length === 0) return { ok: true };
        const services = others.length === 1 ? "service" : "services";
        return {
          ok: false,
          reason: `SLACK_APP_TOKEN belongs to the same Slack app as the running ${services} ${and(others)}; Slack splits Socket Mode events between them, so each factory misses some until its poll catches up`,
          repair: `create a separate Slack app for this factory in ${APP_SETTINGS}, put its SLACK_BOT_TOKEN and SLACK_APP_TOKEN in ${SERVICE_ENV_FILE}, then: \`${RESTART_SERVICE}\``,
        };
      },
    },
  ];
}
