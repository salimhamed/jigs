import { WebAPIPlatformError } from "@slack/web-api";
import type { LanguageModel } from "ai";
import { FACTORY_CONFIG_FILE, resolveSlack, type SlackConfig } from "jigs";
import { RESTART_SERVICE, SERVICE_ENV_FILE } from "jigs/checks";
import type { ISql } from "postgres";
import type { Factory } from "../src/factory";
import { factoryRoot } from "../src/preflight";
import {
  cancelRun,
  logsPointer,
  pokeRun,
  runDetail,
  runTimeline,
} from "../src/run-actions";
import {
  onRunStarted,
  type RunOrigin,
  type RunStarted,
} from "../src/run-events";
import {
  listRuns,
  type RunRow,
  resolveRunRef,
  TERMINAL_RUN_STATUSES,
} from "../src/runs";
import { answerThread } from "../src/slack/agent";
import { connectSlack } from "../src/slack/connection";
import { createSlackDispatcher } from "../src/slack/dispatch";
import { SLACK_APP_TOKEN, SLACK_BOT_TOKEN } from "../src/slack/env";
import { resolveSlackModel, SLACK_MODEL_CREDENTIAL } from "../src/slack/model";
import { createRunThreads } from "../src/slack/run-threads";
import { ensureSlackThreads } from "../src/slack/threads-table";
import { slackTools } from "../src/slack/tools";
import { type BotIdentity, type SlackWeb, slackWeb } from "../src/slack/web";
import { startRun } from "../src/trigger";
import { registrySql } from "../src/worktrees/sql";

// Slack's own words for "this token will never work". Anything else —
// a socket hiccup, a 500, rate limiting, DNS — is the network having a
// moment, and a factory does not stop building because of one.
const AUTH_FAILURES: ReadonlySet<string> = new Set([
  "invalid_auth",
  "not_authed",
  "account_inactive",
  "token_revoked",
  "token_expired",
]);

// Three retries over 17s, four tries in all. Long enough to cross a restart
// of whatever was in the way, short enough that a service start is not held
// open on it.
const AUTH_BACKOFF_MS = [2_000, 5_000, 10_000];

export interface SlackStartDeps {
  slack?: () => SlackConfig | null;
  env?: NodeJS.ProcessEnv;
  web?: (botToken: string) => SlackWeb;
  model?: (modelId: string, env: NodeJS.ProcessEnv) => LanguageModel;
  connect?: typeof connectSlack;
  exit?: (code: number) => void;
  log?: (line: string) => void;
  error?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  sql?: () => ISql | null;
  ensureThreads?: (sql: ISql) => Promise<void>;
  onRunStarted?: typeof onRunStarted;
  listRuns?: () => Promise<RunRow[]>;
  runThreads?: typeof createRunThreads;
}

/**
 * Optional feature, loud when misconfigured: no block is a logged skip and a
 * normal start, a declared block without its credentials is exit 1. Nitro
 * neither awaits its plugins nor fails on a rejected one, so exiting is the
 * only way a half-configured Slack app stops the service (the same reason the
 * World's gates exit rather than throw).
 *
 * Misconfigured, though — not unreachable. Slack being down is not a reason
 * this factory cannot build, so the one call made before the socket degrades
 * to a skip rather than an exit unless Slack said the token itself is dead.
 */
export async function startSlack(
  factory: Factory,
  deps: SlackStartDeps = {},
): Promise<boolean> {
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

  const missing = [
    SLACK_BOT_TOKEN,
    SLACK_APP_TOKEN,
    SLACK_MODEL_CREDENTIAL.env,
  ].filter((name) => !env[name]);
  if (missing.length > 0) {
    error(
      `[slack] ${and(missing)} unset, but ${FACTORY_CONFIG_FILE} declares a slack block`,
    );
    error(
      `  → set ${and(missing)} in ${SERVICE_ENV_FILE} (\`jigs slack manifest\` prints where the two Slack tokens come from; the model key is ${SLACK_MODEL_CREDENTIAL.provider}'s, from ${SLACK_MODEL_CREDENTIAL.where}), or drop the slack block, then: ${RESTART_SERVICE}`,
    );
    exit(1);
    return false;
  }

  const web = (deps.web ?? slackWeb)(env[SLACK_BOT_TOKEN] as string);

  // Subscribed before the auth probe, and buffered until there is somewhere to
  // put them: nitro neither awaits this plugin nor holds the trigger route
  // open on it, so `jigs run` answers while the backoff below is still
  // sleeping. Those runs are exactly the ones a first start is about, and an
  // empty listener set would drop them.
  const backlog = new StartedRuns();
  const unsubscribe = (deps.onRunStarted ?? onRunStarted)((event) =>
    backlog.take(event),
  );

  // Before the socket: the bot's own ids are what tell its posts from the
  // operator's in a thread, and without them every reply it made reads back
  // as something the operator said.
  const identity = await identify(web, deps, log);
  if (identity.kind === "rejected") {
    unsubscribe();
    error(`[slack] auth.test failed: ${identity.reason}`);
    error(
      `  → check ${SLACK_BOT_TOKEN} in ${SERVICE_ENV_FILE} (the app's Bot User OAuth Token), then: ${RESTART_SERVICE}`,
    );
    exit(1);
    return false;
  }
  if (identity.kind === "unreachable") {
    unsubscribe();
    // The same posture a failed schedule takes: this factory's runs do not
    // depend on Slack, and a service that refuses to start is a worse answer
    // than one that starts without a feature nobody can reach anyway.
    log(`[slack] skipped: could not reach Slack (${identity.reason})`);
    return true;
  }

  // The run→thread table, ensured before anything can start a run — the same
  // gate the World plugin runs for the worktree registry, over the same
  // lazily-opened connection, for this factory's other jigs-owned table.
  let sql: ISql | null;
  try {
    sql = (deps.sql ?? registrySql)();
  } catch (err) {
    unsubscribe();
    error(`[slack] the World's Postgres is unreachable: ${describe(err)}`);
    exit(1);
    return false;
  }
  if (sql === null) {
    log("[slack] run threads skipped: WORKFLOW_POSTGRES_URL unset");
  } else {
    try {
      await (deps.ensureThreads ?? ensureSlackThreads)(sql);
    } catch (err) {
      unsubscribe();
      error(`[slack] jigs_slack_threads unusable: ${describe(err)}`);
      error(
        `  → check WORKFLOW_POSTGRES_URL in ${SERVICE_ENV_FILE} and that the World's database is up, then: ${RESTART_SERVICE}`,
      );
      exit(1);
      return false;
    }
  }

  const rows = deps.listRuns ?? (() => listRuns(factory));
  const runThreads = (deps.runThreads ?? createRunThreads)({
    channel: slack.channel,
    sql: () => sql,
    openThread: (channel, text) => web.open(channel, text),
    postReply: (channel, threadTs, text) => web.post(channel, threadTs, text),
    listRuns: rows,
    runDetail,
    log,
    error,
  });
  // Never awaited: a run must not wait on Slack to be told about it.
  backlog.drainTo((event) => {
    void runThreads.runStarted(event);
  });

  const model = (deps.model ?? resolveSlackModel)(slack.model, env);
  // Rebuilt per turn rather than once: which thread a run was started from is
  // what maps it to that thread, and only the turn knows.
  const toolsFor = (origin: RunOrigin) =>
    slackTools({
      factory,
      startRun: (pipeline, inputs) =>
        startRun(factory, pipeline, inputs, crypto.randomUUID(), origin),
      logsPointer,
      listRuns: rows,
      resolveRunRef: (ref) => resolveRunRef(ref),
      runDetail,
      runTimeline,
      cancelRun,
      pokeRun,
    });
  const dispatch = createSlackDispatcher({
    bot: identity.bot,
    allowedUsers: slack.allowed_users,
    fetchThread: (channel, threadTs, trigger) =>
      web.replies(channel, threadTs, trigger),
    runContext: (thread) =>
      runThreads.threadRun(thread.channel, thread.threadTs),
    answer: (messages, { thread, run }) =>
      answerThread(messages, {
        model,
        tools: toolsFor({
          kind: "slack-thread",
          channel: thread.channel,
          threadTs: thread.threadTs,
        }),
        pipelines: Object.keys(factory.pipelines),
        run,
      }),
    post: (channel, threadTs, text) => web.post(channel, threadTs, text),
    error,
  });

  try {
    await (deps.connect ?? connectSlack)({
      appToken: env[SLACK_APP_TOKEN] as string,
      allowedUsers: slack.allowed_users,
      dispatch,
      log,
      error,
    });
  } catch (err) {
    // socket-mode backs off and retries anything recoverable itself, so a
    // rejected start() is Slack refusing the app token — waiting fixes none
    // of the five reasons it does that.
    unsubscribe();
    error(`[slack] could not open a Socket Mode connection: ${describe(err)}`);
    error(
      `  → check ${SLACK_APP_TOKEN} in ${SERVICE_ENV_FILE} (an xapp- token with the connections:write scope) and that the app has Socket Mode enabled, then: ${RESTART_SERVICE}`,
    );
    exit(1);
    return false;
  }

  // After the socket, not before: milestones a restart missed are worth
  // nobody's slow start, and a World that will not answer must not cost this
  // factory its Slack app.
  try {
    await runThreads.rehydrate(
      (await rows())
        .filter((row) => !TERMINAL_RUN_STATUSES.has(row.status))
        .map((row) => row.runId),
    );
  } catch (err) {
    error(`[slack] could not pick up runs already in flight: ${describe(err)}`);
  }

  log(
    `[slack] listening: channel ${slack.channel}, model ${slack.model}, ${slack.allowed_users.length} allowed user(s)`,
  );
  return true;
}

/**
 * The runs announced before there was anything to do with them. Holds them
 * until a destination arrives, then becomes a pass-through — so a run started
 * during the auth backoff gets its thread late rather than never.
 */
class StartedRuns {
  private held: RunStarted[] | null = [];
  private to: ((event: RunStarted) => void) | null = null;

  take(event: RunStarted): void {
    if (this.to === null) this.held?.push(event);
    else this.to(event);
  }

  drainTo(destination: (event: RunStarted) => void): void {
    this.to = destination;
    const held = this.held ?? [];
    this.held = null;
    for (const event of held) destination(event);
  }
}

type Identity =
  | { kind: "known"; bot: BotIdentity }
  | { kind: "rejected"; reason: string }
  | { kind: "unreachable"; reason: string };

async function identify(
  web: SlackWeb,
  deps: SlackStartDeps,
  log: (line: string) => void,
): Promise<Identity> {
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  let last = "";
  for (const backoff of [...AUTH_BACKOFF_MS, null]) {
    try {
      return { kind: "known", bot: await web.authTest() };
    } catch (err) {
      const platform =
        err instanceof WebAPIPlatformError ? err.data.error : undefined;
      // Slack naming the token is the one answer waiting cannot improve.
      if (platform !== undefined && AUTH_FAILURES.has(platform)) {
        return { kind: "rejected", reason: platform };
      }
      last = platform ?? describe(err);
      if (backoff === null) break;
      log(
        `[slack] auth.test did not answer (${last}), retrying in ${backoff}ms`,
      );
      await sleep(backoff);
    }
  }
  return { kind: "unreachable", reason: last };
}

function and(names: readonly string[]): string {
  return names.length < 2
    ? (names[0] ?? "")
    : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// The documented defineNitroPlugin subpath doesn't exist at nitro
// 3.0.260610-beta; a plain default export works. The factory is handed in by
// the generated `.jigs/slack.ts` — only a module in the factory's own tree can
// import its compiled pipelines, and the agent's tools are built from them.
export default async function startSlackPlugin(factory: Factory) {
  await startSlack(factory);
}
