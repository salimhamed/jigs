import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseDocument } from "yaml";
import { z } from "zod";
import { CliError } from "../errors.ts";
import { expandHome } from "../paths.ts";
import { factorySlug } from "../worktrees/layout.ts";

export const FACTORY_CONFIG_FILE = "jigs.yml";

const bindingSchema = z.strictObject({
  path: z.string().min(1),
  remote: z.string().min(1),
  workspace_dir: z.string().min(1).optional(),
  ff_default_branch: z.boolean().default(true),
});

const portSchema = z.int().min(1).max(65535);

const serviceSchema = z.strictObject({
  port: portSchema.default(8990),
  // An optional cap on one step's wall clock (see ../step-timeout.ts). Unset
  // is the default and means none: a step waits as long as it takes. Whole
  // minutes — nothing here is worth expressing more finely.
  step_timeout_minutes: z.int().min(1).optional(),
});

const factoryConfigSchema = z.looseObject({
  bindings: z.record(z.string(), bindingSchema).default({}),
  // Where provider webhooks reach this factory's service (the tunnel URL);
  // `jigs bind` skips its webhook leg while unset.
  ingress_url: z.url().optional(),
  // One service per factory repo, so the address belongs to the factory
  // rather than the machine; the default is the single global service's port.
  // Only non-secret operating parameters live here — the World the service
  // writes is a credential-bearing URL, so it stays in the factory's own .env.
  service: serviceSchema.prefault({}),
});

export type Binding = z.output<typeof bindingSchema>;
export type FactoryConfig = z.output<typeof factoryConfigSchema>;

export function parseFactoryConfig(text: string): FactoryConfig {
  const doc = parseDocument(text);
  const firstError = doc.errors[0];
  if (firstError !== undefined) {
    throw new CliError(`invalid ${FACTORY_CONFIG_FILE}: ${firstError.message}`);
  }
  const result = factoryConfigSchema.safeParse(doc.toJS() ?? {});
  if (!result.success) {
    const lines = result.error.issues.map(
      (issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`,
    );
    throw new CliError(
      `invalid ${FACTORY_CONFIG_FILE}:\n  ${lines.join("\n  ")}`,
    );
  }
  return result.data;
}

export interface ResolvedBinding {
  name: string;
  checkoutRoot: string;
  remote: string;
  workspaceDir?: string;
  ffDefaultBranch: boolean;
}

function resolved(name: string, binding: Binding): ResolvedBinding {
  return {
    name,
    checkoutRoot: expandHome(binding.path),
    remote: binding.remote,
    ...(binding.workspace_dir === undefined
      ? {}
      : { workspaceDir: binding.workspace_dir }),
    ffDefaultBranch: binding.ff_default_branch,
  };
}

// The binding a worktree request names, with `~` and the config's boolean
// defaults already resolved, so callers never re-derive either.
export function resolveBinding(
  factoryRoot: string,
  name: string,
): ResolvedBinding {
  const { bindings } = parseFactoryConfig(readFactoryConfigText(factoryRoot));
  const binding = bindings[name];
  if (binding === undefined) {
    const bound = Object.keys(bindings);
    throw new CliError(
      `no binding named ${name} in ${FACTORY_CONFIG_FILE}`,
      bound.length > 0 ? `bound: ${bound.join(", ")}` : "nothing is bound yet",
    );
  }
  return resolved(name, binding);
}

export function resolveBindings(factoryRoot: string): ResolvedBinding[] {
  const { bindings } = parseFactoryConfig(readFactoryConfigText(factoryRoot));
  return Object.entries(bindings).map(([name, binding]) =>
    resolved(name, binding),
  );
}

export interface ResolvedService {
  slug: string;
  port: number;
  serviceUrl: string;
  // undefined is "no cap", the default.
  stepTimeoutMinutes: number | undefined;
}

// What is addressed per factory: the URL its CLI verbs talk to and the slug
// that keys its pidfile and worktrees.
export function resolveService(factoryRoot: string): ResolvedService {
  const { service } = parseFactoryConfig(readFactoryConfigText(factoryRoot));
  return {
    slug: factorySlug(factoryRoot),
    port: service.port,
    serviceUrl: `http://localhost:${service.port}`,
    stepTimeoutMinutes: service.step_timeout_minutes,
  };
}

export interface BindingPin {
  path: string;
  remote: string;
}

export function upsertBinding(
  text: string,
  name: string,
  pin: BindingPin,
): string {
  const doc = parseDocument(text);
  let changed = false;
  for (const [key, value] of Object.entries(pin)) {
    if (doc.getIn(["bindings", name, key]) !== value) {
      doc.setIn(["bindings", name, key], value);
      changed = true;
    }
  }
  return changed ? doc.toString() : text;
}

export function removeBinding(text: string, name: string): string {
  const doc = parseDocument(text);
  if (!doc.hasIn(["bindings", name])) {
    const bound = Object.keys(parseFactoryConfig(text).bindings);
    throw new CliError(
      `no binding named ${name}`,
      bound.length > 0 ? `bound: ${bound.join(", ")}` : "nothing is bound yet",
    );
  }
  doc.deleteIn(["bindings", name]);
  return doc.toString();
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
