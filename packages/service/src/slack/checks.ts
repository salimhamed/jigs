// Doctor's Slack half. Only a factory that declares a `slack:` block has any
// of these checks at all — an absent block is Slack switched off, not a
// failure. The repair text lives here, beside the Slack error strings it
// translates, so `jigs doctor` says one thing about a misinstalled app.

import { WebAPIPlatformError, WebClient } from "@slack/web-api";
import { FACTORY_CONFIG_FILE, resolveSlack, type SlackConfig } from "jigs";
import {
  type Check,
  type CheckResult,
  RESTART_SERVICE,
  SERVICE_ENV_FILE,
} from "jigs/checks";
import { factoryRoot } from "../preflight";

export const SLACK_BOT_TOKEN = "SLACK_BOT_TOKEN";
export const SLACK_APP_TOKEN = "SLACK_APP_TOKEN";

/** The two Slack calls doctor makes, injected so the checks test without a
 *  network — the same split `CoreProbes` uses for Linear and GitHub. */
export interface SlackProbes {
  authTest(token: string): Promise<unknown>;
  conversationsInfo(token: string, channel: string): Promise<unknown>;
}

const webApiProbes: SlackProbes = {
  authTest: (token) => new WebClient(token).auth.test(),
  conversationsInfo: (token, channel) =>
    new WebClient(token).conversations.info({ channel }),
};

export interface SlackChecksOptions {
  // A thunk, like bindingChecks' factoryRoot: reading the factory config is
  // itself fallible, and doctor must not throw out of its own route.
  slack?: () => SlackConfig | null;
  env?: NodeJS.ProcessEnv;
  probes?: SlackProbes;
}

export function slackChecks(options: SlackChecksOptions = {}): Check[] {
  let slack: SlackConfig | null;
  try {
    slack = (options.slack ?? (() => resolveSlack(factoryRoot())))();
  } catch {
    // An unreadable jigs.yml is already one failed check from bindingChecks;
    // a second copy of it says nothing new, and this one cannot even tell
    // whether Slack was declared.
    return [];
  }
  if (slack === null) return [];
  const env = options.env ?? process.env;
  const probes = options.probes ?? webApiProbes;

  return [
    {
      id: "slack.bot-token",
      label: "Slack bot token",
      run: async (): Promise<CheckResult> => {
        const token = env[SLACK_BOT_TOKEN];
        if (!token) return unset(SLACK_BOT_TOKEN);
        return probeResult(
          () => probes.authTest(token),
          "auth.test",
          slack.channel,
        );
      },
    },
    {
      // Presence only: the one probe of an app token is opening a Socket Mode
      // connection, and this service already holds the one it is allowed.
      id: "slack.app-token",
      label: "Slack app token",
      run: async (): Promise<CheckResult> =>
        env[SLACK_APP_TOKEN] ? { ok: true } : unset(SLACK_APP_TOKEN),
    },
    {
      id: "slack.channel",
      label: `Slack channel ${slack.channel}`,
      run: async (): Promise<CheckResult> => {
        const token = env[SLACK_BOT_TOKEN];
        if (!token) return unset(SLACK_BOT_TOKEN);
        return probeResult(
          () => probes.conversationsInfo(token, slack.channel),
          `conversations.info on ${slack.channel}`,
          slack.channel,
        );
      },
    },
  ];
}

function unset(variable: string): CheckResult {
  return {
    ok: false,
    reason: `${variable} is not set in the service's environment, but ${FACTORY_CONFIG_FILE} declares a slack block`,
    repair: `set ${variable} in ${SERVICE_ENV_FILE} — \`jigs slack manifest\` prints where both tokens come from — then: ${RESTART_SERVICE}`,
  };
}

async function probeResult(
  probe: () => Promise<unknown>,
  call: string,
  channel: string,
): Promise<CheckResult> {
  try {
    await probe();
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      reason: reason(err, call),
      repair: repair(err, channel),
    };
  }
}

// Slack answers a failed call with a machine-readable string, and
// `missing_scope` also names the scope it wanted — which is the whole repair.
function platformData(err: unknown): { error: string; needed?: string } | null {
  return err instanceof WebAPIPlatformError ? err.data : null;
}

function slackError(err: unknown): string | null {
  return platformData(err)?.error ?? null;
}

function reason(err: unknown, call: string): string {
  const data = platformData(err);
  if (data === null) {
    return `Slack ${call} failed: ${err instanceof Error ? err.message : String(err)}`;
  }
  return `Slack ${call} answered ${data.error}${data.needed === undefined ? "" : ` (needs ${data.needed})`}`;
}

function repair(err: unknown, channel: string): string {
  switch (slackError(err)) {
    case "invalid_auth":
    case "not_authed":
    case "token_revoked":
    case "account_inactive":
      return `Slack rejected the bot token — reinstall the app and copy its Bot User OAuth Token into ${SLACK_BOT_TOKEN} in ${SERVICE_ENV_FILE}, then: ${RESTART_SERVICE}`;
    case "missing_scope":
    case "not_allowed_token_type":
      return `the app is missing a scope — compare its OAuth & Permissions page against \`jigs slack manifest\`, reinstall the app, update ${SLACK_BOT_TOKEN} in ${SERVICE_ENV_FILE}, then: ${RESTART_SERVICE}`;
    case "channel_not_found":
    case "not_in_channel":
      return `the bot cannot see ${channel} — invite it there (\`/invite @jigs\` in that channel), or point slack.channel in ${FACTORY_CONFIG_FILE} at a channel it is in, then: ${RESTART_SERVICE}`;
    case "is_archived":
      return `${channel} is archived — point slack.channel in ${FACTORY_CONFIG_FILE} at a live channel, then: ${RESTART_SERVICE}`;
    default:
      return `check this factory's Slack app against \`jigs slack manifest\` and its tokens in ${SERVICE_ENV_FILE}, then: ${RESTART_SERVICE}`;
  }
}
