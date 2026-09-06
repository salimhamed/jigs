// Doctor's Slack half. Only a factory that declares a `slack:` block has any
// of these checks at all — an absent block is Slack switched off, not a
// failure. The repair text lives here, beside the Slack error strings it
// translates, so `jigs doctor` says one thing about a misinstalled app.
//
// Every check here runs in a service that is already up, and a service with a
// slack block cannot be up without its two tokens and its model key set — the
// startup gate exits on that. So what is left to catch is a credential of the
// wrong kind, an app missing a scope, and a channel the bot cannot use.

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
import { listSlackModelIds, SLACK_MODEL_CREDENTIAL } from "./model";

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
  /** Every model id the configured provider will serve. */
  modelIds(apiKey: string): Promise<string[]>;
}

const webApiProbes: SlackProbes = {
  authTest: (token) => new WebClient(token).auth.test(),
  conversationsInfo: (token, channel) =>
    new WebClient(token).conversations.info({ channel }),
  modelIds: listSlackModelIds,
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
            "the app's OAuth & Permissions → Bot User OAuth Token — the two Slack tokens are easy to swap",
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
              "the app's Basic Information → App-Level Tokens, scope connections:write — the two Slack tokens are easy to swap",
            ),
    },
    {
      // Presence alone would say nothing — the startup gate already refuses
      // to run without this key, the same invariant that leaves the app token
      // with only its shape to check. What is left is a key from somewhere
      // else pasted in, and the prefix is what catches it.
      id: "slack.model-key",
      label: `${SLACK_MODEL_CREDENTIAL.provider} API key`,
      run: async (): Promise<CheckResult> =>
        (env[SLACK_MODEL_CREDENTIAL.env] ?? "").startsWith(
          SLACK_MODEL_CREDENTIAL.prefix,
        )
          ? { ok: true }
          : wrongKind(
              SLACK_MODEL_CREDENTIAL.env,
              SLACK_MODEL_CREDENTIAL.prefix,
              `${SLACK_MODEL_CREDENTIAL.provider} (${SLACK_MODEL_CREDENTIAL.where})`,
            ),
    },
    {
      // A model id nothing serves is invisible until an operator asks a
      // question and gets an error instead of an answer — the config parses,
      // the service starts, the socket opens. Asking the provider is the only
      // way to know before that.
      id: "slack.model",
      label: `Slack model ${slack.model}`,
      run: async (): Promise<CheckResult> => {
        let known: string[];
        try {
          known = await probes.modelIds(env[SLACK_MODEL_CREDENTIAL.env] ?? "");
        } catch (err) {
          return {
            ok: false,
            reason: `could not read ${SLACK_MODEL_CREDENTIAL.provider}'s model list: ${describe(err)}`,
            repair: `check this machine can reach ${SLACK_MODEL_CREDENTIAL.provider} and that ${SLACK_MODEL_CREDENTIAL.env} in ${SERVICE_ENV_FILE} is valid, then: ${RESTART_SERVICE}`,
          };
        }
        if (known.includes(slack.model)) return { ok: true };
        return {
          ok: false,
          reason: `${SLACK_MODEL_CREDENTIAL.provider} serves no model called ${slack.model}`,
          repair: `set slack.model in ${FACTORY_CONFIG_FILE} to a model id ${SLACK_MODEL_CREDENTIAL.provider} lists${nearest(slack.model, known)}, then: ${RESTART_SERVICE}`,
        };
      },
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

// A typo'd model id is nearly always right about the vendor, so the vendor's
// own catalogue is the shortest way back to the id that was meant.
function nearest(modelId: string, known: readonly string[]): string {
  const vendor = modelId.split("/")[0];
  const siblings =
    vendor === undefined || vendor === ""
      ? []
      : known.filter((id) => id.startsWith(`${vendor}/`)).slice(0, 5);
  return siblings.length === 0 ? "" : ` (it has ${siblings.join(", ")})`;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function wrongKind(
  variable: string,
  prefix: string,
  where: string,
): CheckResult {
  return {
    ok: false,
    reason: `${variable} is not a ${prefix}… token`,
    repair: `set ${variable} in ${SERVICE_ENV_FILE} from ${where}, then: ${RESTART_SERVICE}`,
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
