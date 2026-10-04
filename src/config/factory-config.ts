import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { z } from "zod";
import { JigsError } from "../errors.ts";
import { agentsSchema } from "../workflow/factory.ts";
import { PROVIDERS, perProvider, WEBHOOK_PROVIDERS } from "../workflow/providers.ts";
import { type MergeApproval, mergeApprovalSchema } from "../workflow/pull-requests/policy.ts";
import { releaseSchema } from "../workflow/runtime/release.ts";
import { factorySlug } from "./paths.ts";

export const FACTORY_CONFIG_FILE = "jigs.config.ts";

const require = createRequire(import.meta.url);

const mergeMethodSchema = z.enum(["squash", "merge", "rebase"]) as z.ZodEnum<{
  /** Combine the branch into one commit. */
  squash: "squash";
  /** Create a merge commit that preserves the branch history. */
  merge: "merge";
  /** Replay the branch commits onto the base branch. */
  rebase: "rebase";
}>;

/** The GitHub merge method: squash, merge commit or rebase. */
export type MergeMethod = z.output<typeof mergeMethodSchema>;

// A binding is a name, a remote URL, how jigs merges there, and how a
// worktree cut from that remote is provisioned — the single place that story
// is told. Where the clone lives is jigs' business, and every other fact is
// derived from git at each activation.
export const bindingSchema = z.strictObject({
  remote: z.string().min(1),
  /** The GitHub merge method jigs uses on this repository. Defaults to `squash`. */
  mergeMethod: mergeMethodSchema.default("squash"),
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
  // How often the service wakes each parked run to re-read its provider, and
  // polls each event trigger's source. With that provider's webhook on, this is
  // only the floor under a lost delivery.
  pollIntervalSeconds: z.preprocess(
    (section) => section ?? {},
    z.strictObject(perProvider(PROVIDERS, pollIntervalSchema)),
  ),
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

const factoryConfigSchema = z.looseObject({
  bindings: z.record(z.string(), bindingSchema).default({}),
  // Where provider webhooks reach this factory's service (the tunnel URL), and
  // which providers send them. Absent, the service only polls.
  webhooks: webhooksSchema.optional(),
  // One service per factory repo, so the addresses belong to the factory
  // rather than the machine. Only non-secret operating parameters live here —
  // the World the service writes is a credential-bearing URL, so it stays in
  // the factory's own .env. An absent section is read as an empty one, so what
  // it is missing reports itself by name.
  service: z.preprocess((section) => section ?? {}, serviceSchema),
  // Which GitHub credential jigs uses, and how the operator approves a merge.
  github: z.preprocess((section) => section ?? {}, githubSchema),
  linear: z.preprocess((section) => section ?? {}, linearSchema),
  pagerduty: pagerDutySchema.optional(),
  // Absent, the factory has no Slack app. Socket Mode is stated outright for
  // the same reason each webhook provider is.
  slack: slackSchema.optional(),
  release: releaseSchema.optional(),
  // Service variables every agent harness receives beyond jigs' base set.
  agents: z.preprocess((section) => section ?? {}, agentsSchema),
});

export type BindingEntry = z.output<typeof bindingSchema>;
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
      (issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`,
    );
    throw new JigsError(`invalid ${FACTORY_CONFIG_FILE}:\n  ${lines.join("\n  ")}`);
  }
  return result.data;
}

/** Load and validate the factory configuration. Node caches the TypeScript
 * module graph, so a process keeps the configuration it started with. */
export function readFactoryConfig(factoryRoot: string): FactoryConfig {
  const filename = factoryConfigPath(factoryRoot);
  try {
    const module = require(filename) as { default?: unknown };
    return parseFactoryConfig(module.default ?? module);
  } catch (error) {
    if (error instanceof JigsError) throw error;
    throw new JigsError(
      `cannot load ${filename}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

// The binding as everything downstream sees it: the operator's entry with its
// provisioning defaults applied, plus the name the caller asked for.
export interface Binding extends BindingEntry {
  name: string;
}

export function resolveBinding(factoryRoot: string, name: string): Binding {
  const { bindings } = readFactoryConfig(factoryRoot);
  const binding = bindings[name];
  if (binding === undefined) {
    const bound = Object.keys(bindings);
    throw new JigsError(
      `no binding named ${name} in ${FACTORY_CONFIG_FILE}`,
      bound.length > 0 ? `bound: ${bound.join(", ")}` : "nothing is bound yet",
    );
  }
  return { name, ...binding };
}

export interface ResolvedService {
  slug: string;
  port: number;
  serviceUrl: string;
  dashboardPort: number;
  dashboardUrl: string;
}

// What is addressed per factory: the URL its CLI verbs talk to and the slug
// that keys its pidfile and its bindings' directories.
export function resolveService(factoryRoot: string): ResolvedService {
  const { service } = readFactoryConfig(factoryRoot);
  return {
    slug: factorySlug(factoryRoot),
    port: service.port,
    serviceUrl: `http://localhost:${service.port}`,
    dashboardPort: service.dashboardPort,
    dashboardUrl: `http://localhost:${service.dashboardPort}`,
  };
}

function factoryConfigPath(factoryRoot: string): string {
  return path.join(factoryRoot, FACTORY_CONFIG_FILE);
}

export function readFactoryConfigText(factoryRoot: string): string {
  return readFileSync(factoryConfigPath(factoryRoot), "utf8");
}

export function writeFactoryConfigText(factoryRoot: string, text: string): void {
  writeFileSync(factoryConfigPath(factoryRoot), text);
}
