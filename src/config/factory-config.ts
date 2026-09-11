import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createJiti } from "jiti";

import { z } from "zod";
import { JigsError } from "../errors.ts";
import { factorySlug } from "../steps/worktree/layout.ts";

export const FACTORY_CONFIG_FILE = "jigs.config.ts";

// A binding is a name, a remote URL, and how a worktree cut from that remote
// is provisioned — the single place that story is told. Where the clone lives
// is jigs' business, and every other fact is derived from git at each
// activation.
const bindingSchema = z.strictObject({
  remote: z.string().min(1),
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
});

export type BindingEntry = z.output<typeof bindingSchema>;
export type FactoryConfig = z.output<typeof factoryConfigSchema>;

export function parseFactoryConfig(value: unknown): FactoryConfig {
  const result = factoryConfigSchema.safeParse(value);
  if (!result.success) {
    const lines = result.error.issues.map(
      (issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`,
    );
    throw new JigsError(
      `invalid ${FACTORY_CONFIG_FILE}:\n  ${lines.join("\n  ")}`,
    );
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

export function writeFactoryConfigText(
  factoryRoot: string,
  text: string,
): void {
  writeFileSync(factoryConfigPath(factoryRoot), text);
}
