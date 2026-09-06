import { FACTORY_CONFIG_FILE, resolveSlack, type SlackConfig } from "jigs";
import { RESTART_SERVICE, SERVICE_ENV_FILE } from "jigs/checks";
import { factoryRoot } from "../src/preflight";
import { SLACK_APP_TOKEN, SLACK_BOT_TOKEN } from "../src/slack/checks";
import { connectSlack } from "../src/slack/connection";

export interface SlackStartDeps {
  slack?: () => SlackConfig | null;
  env?: NodeJS.ProcessEnv;
  connect?: typeof connectSlack;
  exit?: (code: number) => void;
  log?: (line: string) => void;
  error?: (line: string) => void;
}

/**
 * Optional feature, loud when declared: no block is a logged skip and a
 * normal start, a declared block without its tokens is exit 1. Nitro neither
 * awaits its plugins nor fails on a rejected one, so exiting is the only way
 * a half-configured Slack app stops the service (the same reason the World's
 * gates exit rather than throw).
 */
export async function startSlack(deps: SlackStartDeps = {}): Promise<boolean> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const error = deps.error ?? ((line: string) => console.error(line));
  const exit = deps.exit ?? process.exit;
  const env = deps.env ?? process.env;

  let slack: SlackConfig | null;
  try {
    slack = (deps.slack ?? (() => resolveSlack(factoryRoot())))();
  } catch (err) {
    error(`[slack] ${FACTORY_CONFIG_FILE} unreadable: ${describe(err)}`);
    exit(1);
    return false;
  }
  if (slack === null) {
    log(`[slack] skipped: ${FACTORY_CONFIG_FILE} declares no slack block`);
    return true;
  }

  const missing = [SLACK_BOT_TOKEN, SLACK_APP_TOKEN].filter(
    (name) => !env[name],
  );
  if (missing.length > 0) {
    error(
      `[slack] ${missing.join(" and ")} unset, but ${FACTORY_CONFIG_FILE} declares a slack block`,
    );
    error(
      `  → set ${missing.join(" and ")} in ${SERVICE_ENV_FILE} (\`jigs slack manifest\` prints where both come from), or drop the slack block, then: ${RESTART_SERVICE}`,
    );
    exit(1);
    return false;
  }

  try {
    await (deps.connect ?? connectSlack)({
      appToken: env[SLACK_APP_TOKEN] as string,
      allowedUsers: slack.allowed_users,
      log,
      error,
    });
  } catch (err) {
    // socket-mode backs off and retries anything recoverable itself, so a
    // rejected start() is Slack refusing the app token — waiting fixes none
    // of the five reasons it does that.
    error(`[slack] could not open a Socket Mode connection: ${describe(err)}`);
    error(
      `  → check ${SLACK_APP_TOKEN} in ${SERVICE_ENV_FILE} (an xapp- token with the connections:write scope) and that the app has Socket Mode enabled, then: ${RESTART_SERVICE}`,
    );
    exit(1);
    return false;
  }

  log(
    `[slack] listening: channel ${slack.channel}, ${slack.allowed_users.length} allowed user(s)`,
  );
  return true;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// The documented defineNitroPlugin subpath doesn't exist at nitro
// 3.0.260610-beta; a plain default export works.
export default async function startSlackPlugin() {
  await startSlack();
}
