import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createJiti } from "jiti";

import { z } from "zod";
import { type MergePolicy, mergePolicySchema } from "../blocks/pull-requests/policy.ts";
import { releaseSchema } from "../blocks/runtime/release.ts";
import { JigsError } from "../errors.ts";
import { factorySlug } from "../steps/workspaces/layout.ts";

export const FACTORY_CONFIG_FILE = "jigs.config.ts";

// A binding is a name, a remote URL, repository-specific policy, and how a
// worktree cut from that remote is provisioned — the single place that story
// is told. Where the clone lives is jigs' business, and every other fact is
// derived from git at each activation.
const bindingSchema = z.strictObject({
  remote: z.string().min(1),
  // Repository policy may differ between bindings. Approval remains a
  // factory identity concern and is deliberately not accepted here.
  merge: z
    .strictObject({
      by: z.enum(["jigs", "human"]).optional(),
      method: z.enum(["squash", "merge", "rebase"]).optional(),
    })
    .optional(),
  // Paths, or globs, relative to this binding's own `bindings/<name>/`
  // directory in the factory repo; each lands at that same relative path in
  // the worktree. For what git does not carry.
  copy: z.array(z.string()).default([]),
  postCreate: z.array(z.string()).default([]),
  hookTimeoutMinutes: z.number().positive().default(10),
});

const portSchema = z.int().min(1).max(65535);

const serviceSchema = z.strictObject({
  port: portSchema.default(8990),
  // Where this factory's service hosts the SDK's run dashboard. Required and
  // never derived: a default would silently land on another factory's service
  // port, and the two numbers have to be the operator's to move.
  dashboardPort: portSchema,
});

// Who jigs is on GitHub. `pat` is the operator's own token, so every pull
// request jigs opens is authored by the operator and GitHub refuses to let
// them approve it. `app` mints an installation token, so pull requests come
// from `<app-slug>[bot]` and the operator can review them normally; the
// operator login is named here because `GET /user` does not answer for an
// installation token.
const appIdentitySchema = z
  .strictObject({
    mode: z.literal("app"),
    appId: z.int().positive(),
    installationId: z.int().positive().optional(),
    installations: z.record(z.string().regex(/^[a-zA-Z0-9-]+$/), z.int().positive()).optional(),
    // Relative paths resolve against the factory root.
    privateKeyPath: z.string().min(1),
    operator: z.string().min(1),
    coAuthor: z.string().min(1).optional(),
  })
  .superRefine((identity, ctx) => {
    if ((identity.installationId === undefined) === (identity.installations === undefined)) {
      ctx.addIssue({
        code: "custom",
        path: ["installations"],
        message: "provide exactly one of installationId or installations",
      });
    }
    if (identity.installations !== undefined && Object.keys(identity.installations).length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["installations"],
        message: "installations must not be empty",
      });
    }
  });

export const githubIdentitySchema = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("pat") }),
  appIdentitySchema,
]);

export const githubSchema = z
  .strictObject({
    identity: githubIdentitySchema.optional(),
    identities: z.array(appIdentitySchema).min(1).optional(),
  })
  .superRefine((github, ctx) => {
    if (github.identity !== undefined && github.identities !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["identities"],
        message: "provide exactly one of identity or identities",
      });
    }
    const accounts = new Set<string>();
    for (const [index, identity] of (
      github.identities ?? (github.identity ? [github.identity] : [])
    ).entries()) {
      if (identity.mode !== "app") continue;
      if (github.identities && identity.installations === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["identities", index, "installations"],
          message: "identities entries require installations",
        });
      }
      for (const account of Object.keys(identity.installations ?? {})) {
        if (accounts.has(account.toLowerCase()))
          ctx.addIssue({
            code: "custom",
            path: github.identities
              ? ["identities", index, "installations", account]
              : ["identity", "installations", account],
            message: `account ${account} is claimed more than once`,
          });
        accounts.add(account.toLowerCase());
      }
    }
  })
  .transform((github) => ({
    identities: github.identities ?? [github.identity ?? { mode: "pat" as const }],
  }));

/** Resolve one account; legacy installationId intentionally covers every account. */
export function installationFor(identities: GithubIdentity[], account: string): GithubIdentity {
  for (const identity of identities) {
    if (identity.mode === "pat" || identity.installationId !== undefined) return identity;
    const entry = Object.entries(identity.installations ?? {}).find(
      ([login]) => login.toLowerCase() === account.toLowerCase(),
    );
    if (entry) return { ...identity, installationId: entry[1] };
  }
  throw new JigsError(
    `no GitHub App installation configured for account ${account}`,
    `add "${account}": <installation-id> to the App's installations in github.identity or github.identities in jigs.config.ts, then: jigs up`,
  );
}

const factoryConfigSchema = z.looseObject({
  bindings: z.record(z.string(), bindingSchema).default({}),
  // Where provider webhooks reach this factory's service (the tunnel URL);
  // `jigs bind` skips its webhook leg while unset.
  ingressUrl: z.url().optional(),
  // One service per factory repo, so the addresses belong to the factory
  // rather than the machine. Only non-secret operating parameters live here —
  // the World the service writes is a credential-bearing URL, so it stays in
  // the factory's own .env. An absent block is read as an empty one, so what
  // it is missing reports itself by name.
  service: z.preprocess((block) => block ?? {}, serviceSchema),
  // Which GitHub credential jigs uses. Nothing downstream reads the identity
  // to decide policy — `merge` below states the policy outright.
  github: z.preprocess((block) => block ?? {}, githubSchema),
  // This factory's merge policy: who merges, by which of GitHub's three merge
  // methods, and what signal permits it.
  release: releaseSchema.optional(),
  merge: z.preprocess((block) => block ?? {}, mergePolicySchema),
});

export type BindingEntry = z.output<typeof bindingSchema>;
export type FactoryConfig = z.output<typeof factoryConfigSchema>;
export type GithubIdentity = z.output<typeof githubIdentitySchema>;
export type AppIdentity = Extract<GithubIdentity, { mode: "app" }>;
/** The policy a factory that states none gets: a human merges, by squash, on an approving review. */
export const defaultMergePolicy = (): MergePolicy => mergePolicySchema.parse({});

export function parseFactoryConfig(value: unknown): FactoryConfig {
  const result = factoryConfigSchema.safeParse(value);
  if (!result.success) {
    const lines = result.error.issues.map((issue) => {
      const path = issue.path.join(".") || "(root)";
      if (
        issue.code === "unrecognized_keys" &&
        issue.path.at(-1) === "merge" &&
        issue.keys.includes("approval")
      ) {
        return `${path}.approval: approval is factory-level because it follows github.identity; a binding may only override merge.by and merge.method`;
      }
      return `${path}: ${issue.message}`;
    });
    throw new JigsError(`invalid ${FACTORY_CONFIG_FILE}:\n  ${lines.join("\n  ")}`);
  }
  return result.data;
}

/** Load configuration without invoking its deferred workflow imports. Disable
 * both caches so a long-running process sees edits, including imported settings. */
export function readFactoryConfig(factoryRoot: string): FactoryConfig {
  const filename = factoryConfigPath(factoryRoot);
  try {
    const load = createJiti(filename, { moduleCache: false, fsCache: false });
    const module = load(filename) as { default?: unknown };
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

/** Apply a binding's repository-specific overrides to the factory policy. */
export function bindingMergePolicy(
  merge: MergePolicy,
  binding: Pick<BindingEntry, "merge">,
): MergePolicy {
  return { ...merge, ...binding.merge };
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
