// Doctor's Slack half. Only a factory that declares a `slack:` block has any
// of these checks at all — an absent block is Slack switched off, not a
// failure. The repair text lives here, beside the Slack error strings it
// translates, so `jigs doctor` says one thing about a misinstalled app.
//
// Every check here runs in a service that is already up, and a service with a
// slack block cannot be up without both tokens set — the startup gate exits
// on that. So what is left to catch is a token of the wrong kind, an app
// missing a scope, and a channel the bot cannot use.

// Static, not a dynamic import: see the note in connection.ts — the e2e boot
// stage is what proves a `link:`-installed factory resolves this package.
import { WebAPIPlatformError, WebClient } from "@slack/web-api";
import { FACTORY_CONFIG_FILE, resolveSlack, type SlackConfig } from "jigs";
import {
  type Check,
  type CheckResult,
  RESTART_SERVICE,
  SERVICE_ENV_FILE,
} from "jigs/checks";
import { factoryRoot } from "../preflight";
import {
  APP_TOKEN_PREFIX,
  BOT_TOKEN_PREFIX,
  SLACK_APP_TOKEN,
  SLACK_BOT_TOKEN,
} from "./env";

/** What doctor reads back off `conversations.info`: an ok answer is not the
 *  same as a usable channel. */
export interface ConversationInfo {
  channel?: { is_member?: boolean; is_archived?: boolean };
}

/** The two Slack calls doctor makes, injected so the checks test without a
 *  network — the same split `CoreProbes` uses for Linear and GitHub. */
export interface SlackProbes {
  authTest(token: string): Promise<unknown>;
  conversationsInfo(token: string, channel: string): Promise<ConversationInfo>;
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
  const channel = slack.channel;

  return [
    {
      id: "slack.bot-token",
      label: "Slack bot token",
      run: async (): Promise<CheckResult> => {
        const token = env[SLACK_BOT_TOKEN] ?? "";
        if (!token.startsWith(BOT_TOKEN_PREFIX)) {
          return wrongKind(
            SLACK_BOT_TOKEN,
            BOT_TOKEN_PREFIX,
            "OAuth & Permissions → Bot User OAuth Token",
          );
        }
        try {
          await probes.authTest(token);
          return { ok: true };
        } catch (err) {
          return apiFailure(err, "auth.test", channel);
        }
      },
    },
    {
      // The only probe of an app token is opening a Socket Mode connection,
      // and this service already holds the one it is allowed — so its shape is
      // what doctor can honestly check, and the two tokens pasted the wrong
      // way round is what that catches.
      id: "slack.app-token",
      label: "Slack app token",
      run: async (): Promise<CheckResult> =>
        (env[SLACK_APP_TOKEN] ?? "").startsWith(APP_TOKEN_PREFIX)
          ? { ok: true }
          : wrongKind(
              SLACK_APP_TOKEN,
              APP_TOKEN_PREFIX,
              "Basic Information → App-Level Tokens, scope connections:write",
            ),
    },
    {
      id: "slack.channel",
      label: `Slack channel ${channel}`,
      run: async (): Promise<CheckResult> => {
        try {
          const info = await probes.conversationsInfo(
            env[SLACK_BOT_TOKEN] ?? "",
            channel,
          );
          // conversations.info answers for a channel the bot can see but has
          // not joined, and for one nobody can post to at all, so an ok is not
          // yet a channel run threads can open in.
          if (info.channel?.is_archived === true) {
            return {
              ok: false,
              reason: `${channel} is archived`,
              repair: archived(channel),
            };
          }
          if (info.channel?.is_member === false) {
            return {
              ok: false,
              reason: `the bot is not a member of ${channel}`,
              repair: invite(channel),
            };
          }
          return { ok: true };
        } catch (err) {
          return apiFailure(err, `conversations.info on ${channel}`, channel);
        }
      },
    },
  ];
}

function wrongKind(
  variable: string,
  prefix: string,
  where: string,
): CheckResult {
  return {
    ok: false,
    reason: `${variable} is not a ${prefix}… token`,
    repair: `set ${variable} in ${SERVICE_ENV_FILE} from the app's ${where} — the two Slack tokens are easy to swap — then: ${RESTART_SERVICE}`,
  };
}

const invite = (channel: string) =>
  `invite the bot to ${channel} (\`/invite @jigs\` in that channel), or point slack.channel in ${FACTORY_CONFIG_FILE} at a channel it is in, then: ${RESTART_SERVICE}`;

const archived = (channel: string) =>
  `point slack.channel in ${FACTORY_CONFIG_FILE} at a live channel — ${channel} is archived — then: ${RESTART_SERVICE}`;

function apiFailure(err: unknown, call: string, channel: string): CheckResult {
  return { ok: false, reason: reason(err, call), repair: repair(err, channel) };
}

// Slack answers a failed call with a machine-readable string, and
// `missing_scope` also names the scope it wanted — which is the whole repair.
function platformData(err: unknown): { error: string; needed?: string } | null {
  return err instanceof WebAPIPlatformError ? err.data : null;
}

function reason(err: unknown, call: string): string {
  const data = platformData(err);
  if (data === null) {
    return `Slack ${call} failed: ${err instanceof Error ? err.message : String(err)}`;
  }
  return `Slack ${call} answered ${data.error}${data.needed === undefined ? "" : ` (needs ${data.needed})`}`;
}

function repair(err: unknown, channel: string): string {
  switch (platformData(err)?.error) {
    case "invalid_auth":
    case "not_authed":
    case "token_revoked":
    case "account_inactive":
      return `Slack rejected the bot token — reinstall the app and copy its Bot User OAuth Token into ${SLACK_BOT_TOKEN} in ${SERVICE_ENV_FILE}, then: ${RESTART_SERVICE}`;
    case "missing_scope":
      return `the app is missing a scope — compare its OAuth & Permissions page against \`jigs slack manifest\`, reinstall the app, update ${SLACK_BOT_TOKEN} in ${SERVICE_ENV_FILE}, then: ${RESTART_SERVICE}`;
    case "not_allowed_token_type":
      return `that call takes a bot token and ${SLACK_BOT_TOKEN} holds another kind — copy the app's Bot User OAuth Token (${BOT_TOKEN_PREFIX}…, not a user or an app-level token) into ${SERVICE_ENV_FILE}, then: ${RESTART_SERVICE}`;
    case "channel_not_found":
      return invite(channel);
    default:
      return `check this factory's Slack app against \`jigs slack manifest\` and its tokens in ${SERVICE_ENV_FILE}, then: ${RESTART_SERVICE}`;
  }
}
