import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseDocument } from "yaml";
import { z } from "zod";
import { CliError } from "../errors.ts";
import { factorySlug } from "../worktrees/layout.ts";

export const FACTORY_CONFIG_FILE = "jigs.yml";

// A binding is a name and a remote URL, nothing more: where the clone lives is
// jigs' business and every other fact is derived from git at each activation.
const bindingSchema = z.strictObject({
  remote: z.string().min(1),
});

const portSchema = z.int().min(1).max(65535);

const serviceSchema = z.strictObject({
  port: portSchema.default(8990),
  // Where this factory's service hosts the SDK's run dashboard. Required and
  // never derived: a default would silently land on another factory's service
  // port, and the two numbers have to be the operator's to move.
  dashboard_port: portSchema,
});

const factoryConfigSchema = z.looseObject({
  bindings: z.record(z.string(), bindingSchema).default({}),
  // Where provider webhooks reach this factory's service (the tunnel URL);
  // `jigs bind` skips its webhook leg while unset.
  ingress_url: z.url().optional(),
  // One service per factory repo, so the addresses belong to the factory
  // rather than the machine. Only non-secret operating parameters live here —
  // the World the service writes is a credential-bearing URL, so it stays in
  // the factory's own .env. An absent block is read as an empty one, so what
  // it is missing reports itself by name.
  service: z.preprocess((block) => block ?? {}, serviceSchema),
});

export type BindingEntry = z.output<typeof bindingSchema>;
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

export interface Binding {
  name: string;
  remote: string;
}

// The binding a worktree request names, carrying the name the caller asked for
// so nothing downstream has to thread it separately.
export function resolveBinding(factoryRoot: string, name: string): Binding {
  const { bindings } = parseFactoryConfig(readFactoryConfigText(factoryRoot));
  const binding = bindings[name];
  if (binding === undefined) {
    const bound = Object.keys(bindings);
    throw new CliError(
      `no binding named ${name} in ${FACTORY_CONFIG_FILE}`,
      bound.length > 0 ? `bound: ${bound.join(", ")}` : "nothing is bound yet",
    );
  }
  return { name, remote: binding.remote };
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
  const { service } = parseFactoryConfig(readFactoryConfigText(factoryRoot));
  return {
    slug: factorySlug(factoryRoot),
    port: service.port,
    serviceUrl: `http://localhost:${service.port}`,
    dashboardPort: service.dashboard_port,
    dashboardUrl: `http://localhost:${service.dashboard_port}`,
  };
}

// Returns the text unchanged when nothing moved, so a re-bind is byte-identical
// and every comment in the file survives.
export function upsertBinding(
  text: string,
  name: string,
  remote: string,
): string {
  const doc = parseDocument(text);
  if (doc.getIn(["bindings", name, "remote"]) === remote) return text;
  doc.setIn(["bindings", name, "remote"], remote);
  return doc.toString();
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
