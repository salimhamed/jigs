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

/** Whether the bot token is set, accepted by Slack and granted every scope jigs uses. */
export function slackIdentityChecks(probes: SlackProbes, env: EnvLookup = slackEnvValue): Check[] {
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
          return {
            ok: false,
            reason: `SLACK_BOT_TOKEN is set but Slack rejected it: ${err instanceof Error ? err.message : String(err)}`,
            repair: `copy the current Bot User OAuth Token from OAuth & Permissions in ${APP_SETTINGS} into SLACK_BOT_TOKEN in ${SERVICE_ENV_FILE}, installing the app first if it is not installed, then: \`${RESTART_SERVICE}\``,
          };
        }
        if (auth.scopes === null) {
          return {
            ok: false,
            reason:
              "Slack's auth.test answer carried no x-oauth-scopes header, so the bot token's scopes cannot be checked",
            repair:
              "make sure nothing between the service and slack.com strips response headers, then: `pnpm exec jigs doctor`",
          };
        }
        const granted = new Set(auth.scopes);
        const missing = SLACK_BOT_SCOPES.filter((scope) => !granted.has(scope));
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
  slack: SlackConfig,
  probes: SlackProbes,
  env: EnvLookup = slackEnvValue,
): Check[] {
  if (!slack.socketMode) return [];
  const createToken = `create an app-level token with the connections:write scope under Basic Information → App-Level Tokens in ${APP_SETTINGS}`;
  return [
    {
      id: "slack.socket-mode",
      label: "Slack Socket Mode",
      run: async () => {
        if (env("SLACK_APP_TOKEN") === undefined) {
          return {
            ok: false,
            reason: "slack.socketMode is on but SLACK_APP_TOKEN is not set",
            repair: `${createToken}, set it as SLACK_APP_TOKEN in ${SERVICE_ENV_FILE}, then: \`${RESTART_SERVICE}\``,
          };
        }
        try {
          await probes.openConnection();
          return { ok: true };
        } catch (err) {
          const reason = `SLACK_APP_TOKEN could not open a Socket Mode connection: ${err instanceof Error ? err.message : String(err)}`;
          const code = err instanceof SlackApiError ? err.code : undefined;
          const fix =
            code === "missing_scope"
              ? `an app-level token's scopes are fixed when it is made; ${createToken}`
              : code === "not_allowed_token_type"
                ? `SLACK_APP_TOKEN must be an app-level token (xapp-), not the bot token; ${createToken}`
                : `turn on Socket Mode in ${APP_SETTINGS}; if the token was revoked, ${createToken}`;
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
