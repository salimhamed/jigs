// The factory configuration's shape, as pure zod: `defineFactory` validates with it inside the
// workflow bundle, and the CLI and service parse `jigs.config.ts` with it.

import { z } from "zod";
import { JigsError } from "./errors.ts";
import type { EventTrigger, Schedule, WorkflowDefinition } from "./factory.ts";
import { POLLED_PROVIDERS, perProvider, WEBHOOK_PROVIDERS } from "./providers.ts";
import { type MergeApproval, mergeApprovalSchema } from "./pull-requests/policy.ts";
import { releaseSchema } from "./runtime/release.ts";

export const FACTORY_CONFIG_FILE = "jigs.config.ts";

// A driver sets or passes these itself, and a model credential comes from the
// model source; declaring one would override the subscription login or the
// invocation's private home.
export const RESERVED_AGENT_ENV: readonly string[] = [
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
  "PI_CODING_AGENT_DIR",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  "OPENROUTER_API_KEY",
];

const envName = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "must be an environment variable name, never a value")
  .refine(
    (name) => !RESERVED_AGENT_ENV.includes(name),
    "is set by jigs or selects a model credential; name a model credential on its model source instead",
  );

// Names only: values stay in the service environment and are read when an
// agent starts, so none reaches the factory definition or workflow data.
export const agentsSchema = z.strictObject({
  /**
   * Names of service environment variables every agent harness also receives.
   * A harness otherwise starts with only a small base set, such as `PATH` and
   * `HOME`, and the variables its own driver needs. Model credentials and
   * the variables jigs sets itself are refused: name a model credential on
   * its model source instead.
   */
  env: z.array(envName).default([]),
});

// A binding is a name, a remote URL, and how a worktree cut from that remote
// is provisioned — the single place that story is told. Where the clone lives
// is jigs' business, and every other fact is derived from git at each activation.
export const bindingSchema = z.strictObject({
  remote: z.string().min(1),
  // Paths, or globs, relative to this binding's own `bindings/<name>/`
  // directory in the factory repo; each lands at that same relative path in
  // the worktree. For what git does not carry.
  copy: z.array(z.string()).default([]),
  postCreate: z.array(z.string()).default([]),
  hookTimeoutMinutes: z.number().positive().default(10),
});

const portSchema = z.int().min(1).max(65535);

// A floor, so a slip between seconds and minutes cannot turn the sweep into a
// loop of provider reads for every parked run.
const pollIntervalSchema = z.int().min(30).default(300);

const serviceSchema = z.strictObject({
  port: portSchema.default(8990),
  // Where this factory's service hosts the SDK's run dashboard. Required and
  // never derived: a default would silently land on another factory's service
  // port, and the two numbers have to be the operator's to move.
  dashboardPort: portSchema,
  /**
   * Seconds between the service's reads of each provider but GitHub, whose
   * events arrive through the hub: re-reading parked runs, and polling the
   * event triggers whose source is on that provider. Each defaults to 300 and may not go below 30. Up to a tenth
   * of the interval is taken off at random so services do not all poll at
   * once.
   */
  // With that provider's webhook on, this is only the floor under a lost delivery.
  pollIntervalSeconds: z
    .strictObject(perProvider(POLLED_PROVIDERS, pollIntervalSchema))
    .prefault({}),
});

// A provider that is on is stated outright rather than implied by a secret in
// .env: a forgotten secret must be a boot error, not a factory that silently
// polls.
const webhookProviderSchema = z.strictObject({ enabled: z.boolean() }).default({ enabled: false });

export const webhooksSchema = z.strictObject({
  url: z.url(),
  ...perProvider(WEBHOOK_PROVIDERS, webhookProviderSchema),
});

// Who jigs is on GitHub. `pat` is the operator's own token, so every pull
// request jigs opens is authored by the operator and GitHub refuses to let
// them approve it. `app` mints an installation token, so pull requests come
// from `<app-slug>[bot]` and the operator can review them normally; the
// operator login is named here because `GET /user` does not answer for an
// installation token.
const appIdentitySchema = z.strictObject({
  mode: z.literal("app"),
  appId: z.int().positive(),
  installations: z
    .record(z.string().regex(/^[a-zA-Z0-9-]+$/), z.int().positive())
    .refine((entries) => Object.keys(entries).length > 0, "installations must not be empty"),
  // Relative paths resolve against the factory root.
  privateKeyPath: z.string().min(1),
  operator: z.string().min(1),
  coAuthor: z.string().min(1).optional(),
});

export const githubIdentitySchema = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("pat") }),
  appIdentitySchema,
]);

export const githubSchema = z
  .strictObject({
    identities: z
      .array(githubIdentitySchema)
      .min(1)
      .default([{ mode: "pat" }]),
    /**
     * How the operator approves a pull request for merging. Defaults to `label` with a personal
     * access token and to `review` with a GitHub App.
     */
    mergeApproval: mergeApprovalSchema.optional(),
  })
  .superRefine(({ identities, mergeApproval }, ctx) => {
    if (mergeApproval === "review" && identities.some((identity) => identity.mode === "pat"))
      ctx.addIssue({
        code: "custom",
        path: ["mergeApproval"],
        message:
          'with a PAT, jigs opens pull requests as you, and GitHub does not let the author of a pull request approve it; use "label", or a GitHub App identity',
      });
    const accounts = new Set<string>();
    for (const [index, identity] of identities.entries()) {
      if (identity.mode === "pat") {
        if (identities.length !== 1)
          ctx.addIssue({
            code: "custom",
            path: ["identities", index],
            message: "a PAT must be the only identity",
          });
        continue;
      }
      for (const account of Object.keys(identity.installations)) {
        if (accounts.has(account.toLowerCase()))
          ctx.addIssue({
            code: "custom",
            path: ["identities", index, "installations", account],
            message: `account ${account} is claimed more than once`,
          });
        accounts.add(account.toLowerCase());
      }
    }
  })
  .transform(({ identities, mergeApproval }) => ({
    identities,
    mergeApproval: mergeApproval ?? defaultMergeApproval(identities),
  }));

// A PAT makes the operator the author of every pull request, and GitHub
// refuses an author's own approving review.
function defaultMergeApproval(identities: GithubIdentity[]): MergeApproval {
  return identities.some((identity) => identity.mode === "pat") ? "label" : "review";
}

/**
 * Who jigs is on Linear. `key` is a personal API key, so jigs acts as that user.
 * `app` is a Linear OAuth application acting as itself, which mints its own
 * token from a client id and secret.
 *
 * @remarks
 * Only the mode lives in config. The secrets live in the factory's `.env`:
 * `LINEAR_API_KEY` for `key`, `LINEAR_CLIENT_ID` and `LINEAR_CLIENT_SECRET`
 * for `app`.
 */
export const linearIdentitySchema = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("key") }),
  z.strictObject({ mode: z.literal("app") }),
]);

/**
 * A factory's Linear settings: exactly one Linear identity, and optionally the
 * operator, the Linear user's email that every comment jigs posts mentions
 * together with the ticket's assignee.
 */
export const linearSchema = z.strictObject({
  identity: linearIdentitySchema.default({ mode: "key" }),
  operator: z.email().optional(),
});

/**
 * Who jigs is on PagerDuty: a scoped OAuth application acting on one account,
 * which mints its own token from a client id and secret.
 *
 * @remarks
 * `subdomain` and `region` name the account, as in `acme.pagerduty.com` on the
 * `us` service region. `from` is the email of a real PagerDuty user: PagerDuty
 * refuses a write without one, and notes jigs adds are attributed to them. The
 * secrets live in the factory's `.env`: `PAGERDUTY_CLIENT_ID` and
 * `PAGERDUTY_CLIENT_SECRET`.
 */
export const pagerDutyIdentitySchema = z.strictObject({
  mode: z.literal("app"),
  subdomain: z
    .string()
    .regex(
      /^[a-z0-9-]+$/,
      "the account subdomain alone, in lowercase, such as acme for acme.pagerduty.com",
    ),
  region: z.enum(["us", "eu"]),
  from: z.email(),
});

/** A factory's PagerDuty settings: exactly one PagerDuty identity. */
export const pagerDutySchema = z.strictObject({ identity: pagerDutyIdentitySchema });

/**
 * A factory's Slack app. The app always acts as itself, so there is no identity
 * mode; `SLACK_BOT_TOKEN` in `.env` is its credential. With `socketMode` on,
 * the service also holds a Socket Mode connection that delivers messages
 * within a second; it refuses to start without `SLACK_APP_TOKEN`, and doctor
 * checks that token opens a connection. Polling on
 * `service.pollIntervalSeconds.slack` runs either way. `scopes` names the bot
 * scopes the factory's own Slack calls need beyond jigs' own; doctor checks the
 * bot holds them.
 */
export const slackSchema = z.strictObject({
  socketMode: z.boolean(),
  scopes: z.array(z.string().min(1)).default([]),
});

/** Resolve the credentials for one account. */
export function installationFor(
  identities: GithubIdentity[],
  account: string,
): ResolvedGithubIdentity {
  for (const identity of identities) {
    if (identity.mode === "pat") return identity;
    const { installations, ...app } = identity;
    const entry = Object.entries(installations).find(
      ([login]) => login.toLowerCase() === account.toLowerCase(),
    );
    if (entry) return { ...app, installationId: entry[1] };
  }
  throw new JigsError(
    `no GitHub App installation configured for account ${account}`,
    `add "${account}": <installation-id> to the App's installations in github.identities in jigs.config.ts, then: \`pnpm exec jigs up\``,
  );
}

// biome-ignore lint/suspicious/noExplicitAny: heterogeneous schemas per workflow
export type WorkflowImport = () => Promise<{ default: WorkflowDefinition<any> }>;

const inputsSchema = z.record(z.string(), z.unknown());

const scheduleSchema: z.ZodType<Schedule, Schedule> = z.strictObject({
  workflow: z.string(),
  cron: z.string(),
  inputs: inputsSchema,
});

const eventTriggerSchema: z.ZodType<EventTrigger, EventTrigger> = z.strictObject({
  workflow: z.string(),
  source: z.strictObject({ kind: z.string(), params: inputsSchema }),
  inputs: inputsSchema.optional(),
  maxActive: z.number().optional(),
  lookbackMinutes: z.number().optional(),
});

// Strict so a misspelled section fails instead of falling back to defaults.
export const factoryConfigSchema = z
  .strictObject({
    bindings: z.record(z.string(), bindingSchema).default({}),
    // The hub this factory hears its providers through. Its token stays in
    // .env as JIGS_HUB_TOKEN.
    hub: z.strictObject({ url: z.url() }),
    // Where provider webhooks reach this factory's service (the tunnel URL), and
    // which providers send them. Absent, the service only polls.
    webhooks: webhooksSchema.optional(),
    // One service per factory repo, so the addresses belong to the factory
    // rather than the machine. Only non-secret operating parameters live here —
    // the World the service writes is a credential-bearing URL, so it stays in
    // the factory's own .env. An absent section is read as an empty one, so what
    // it is missing reports itself by name.
    service: z.preprocess<unknown, typeof serviceSchema, z.input<typeof serviceSchema>>(
      (section) => section ?? {},
      serviceSchema,
    ),
    // Which GitHub credential jigs uses, and how the operator approves a merge.
    github: githubSchema.prefault({}),
    linear: linearSchema.prefault({}),
    pagerduty: pagerDutySchema.optional(),
    // Absent, the factory has no Slack app. Socket Mode is stated outright for
    // the same reason each webhook provider is.
    slack: slackSchema.optional(),
    release: releaseSchema.optional(),
    // Service variables every agent harness receives beyond jigs' base set.
    agents: agentsSchema.prefault({}),
    // Deferred imports: calling one loads the workflow, which only the service does.
    workflows: z
      .record(
        z.string(),
        z.custom<WorkflowImport>((load) => typeof load === "function", "must be a deferred import"),
      )
      .optional(),
    schedules: z.record(z.string(), scheduleSchema).optional(),
    triggers: z.record(z.string(), eventTriggerSchema).optional(),
  })
  .superRefine(checkStarts);

/** Runs of an event trigger active at once when it does not say. */
export const DEFAULT_MAX_ACTIVE = 20;
/** Minutes an event trigger catches up after downtime when it does not say. */
export const DEFAULT_LOOKBACK_MINUTES = 60;

// What needs neither a loaded workflow nor the service's sources. The service
// checks the rest: the cron, the source and its params, and the inputs.
function checkStarts(
  {
    workflows = {},
    schedules = {},
    triggers = {},
  }: {
    workflows?: Record<string, WorkflowImport>;
    schedules?: Record<string, Schedule>;
    triggers?: Record<string, EventTrigger>;
  },
  ctx: z.RefinementCtx,
): void {
  const problem = (path: string[], reason: string, repair: string) =>
    ctx.addIssue({ code: "custom", path, message: `${reason}\n${repair}` });
  // A run's trigger id appends the tick or occurrence to the name after a ":",
  // and the trigger column and a schedule's overlap skip read the name back by
  // splitting on the first one, so a name carrying its own would answer for
  // another's runs.
  const name = (kind: "schedule" | "trigger", key: string) => {
    if (!key.includes(":")) return;
    problem(
      [`${kind}s`, key],
      `${kind} name "${key}" contains ":"`,
      `rename the "${key}" ${kind} in jigs.config.ts to a name without ":"\na run's trigger id is read back out of the name`,
    );
  };
  const workflow = (at: string[], chosen: string) => {
    if (Object.hasOwn(workflows, chosen)) return;
    problem(
      [...at, "workflow"],
      `workflow "${chosen}" is not one of this factory's workflows`,
      `set ${at.join(".")}.workflow in jigs.config.ts to one of: ${Object.keys(workflows).join(", ")}`,
    );
  };
  for (const [key, schedule] of Object.entries(schedules)) {
    name("schedule", key);
    workflow(["schedules", key], schedule.workflow);
  }
  for (const [key, trigger] of Object.entries(triggers)) {
    const at = ["triggers", key];
    name("trigger", key);
    workflow(at, trigger.workflow);
    const { maxActive, lookbackMinutes } = trigger;
    if (maxActive !== undefined && (!Number.isInteger(maxActive) || maxActive < 1))
      problem(
        [...at, "maxActive"],
        `maxActive ${maxActive} is not a whole number of at least 1`,
        `set triggers.${key}.maxActive in jigs.config.ts to 1 or more, or remove it for the default of ${DEFAULT_MAX_ACTIVE}`,
      );
    if (
      lookbackMinutes !== undefined &&
      (!Number.isFinite(lookbackMinutes) || lookbackMinutes <= 0)
    )
      problem(
        [...at, "lookbackMinutes"],
        `lookbackMinutes ${lookbackMinutes} is not a positive number of minutes`,
        `set triggers.${key}.lookbackMinutes in jigs.config.ts above 0, or remove it for the default of ${DEFAULT_LOOKBACK_MINUTES}`,
      );
  }
}

export type BindingEntry = z.output<typeof bindingSchema>;

// The binding as everything downstream sees it: the operator's entry with its
// provisioning defaults applied, plus the name the caller asked for.
export interface Binding extends BindingEntry {
  name: string;
}

export type FactoryConfig = z.output<typeof factoryConfigSchema>;
export type WebhooksConfig = z.output<typeof webhooksSchema>;
export type SlackConfig = z.output<typeof slackSchema>;

export type GithubIdentity = z.output<typeof githubIdentitySchema>;
/** Who jigs is on Linear: a personal API key, or an OAuth application acting as itself. */
export type LinearIdentity = z.output<typeof linearIdentitySchema>;
/** Who jigs is on PagerDuty: a scoped OAuth application acting on one account. */
export type PagerDutyIdentity = z.output<typeof pagerDutyIdentitySchema>;
export type AppIdentity = Extract<GithubIdentity, { mode: "app" }>;
/** Credentials selected for one installation, after resolving the configured account map. */
export type ResolvedAppIdentity = Omit<AppIdentity, "installations"> & {
  installationId: number;
};
export type ResolvedGithubIdentity = Extract<GithubIdentity, { mode: "pat" }> | ResolvedAppIdentity;

export function parseFactoryConfig(value: unknown): FactoryConfig {
  const result = factoryConfigSchema.safeParse(value);
  if (!result.success) {
    const lines = result.error.issues.map(
      (issue) => `${issue.path.join(".") || "(root)"}: ${issue.message.replaceAll("\n", "\n    ")}`,
    );
    throw new JigsError(`invalid ${FACTORY_CONFIG_FILE}:\n  ${lines.join("\n  ")}`);
  }
  return result.data;
}
