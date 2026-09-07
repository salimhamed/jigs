import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { type Document, parseDocument } from "yaml";
import { z } from "zod";
import { JigsError } from "../errors.ts";
import { factorySlug } from "../worktrees/layout.ts";

export const FACTORY_CONFIG_FILE = "jigs.yml";

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
  post_create: z.array(z.string()).default([]),
  hook_timeout_minutes: z.number().positive().default(10),
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
    throw new JigsError(
      `invalid ${FACTORY_CONFIG_FILE}: ${firstError.message}`,
    );
  }
  const result = factoryConfigSchema.safeParse(doc.toJS() ?? {});
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

// The binding as everything downstream sees it: the operator's entry with its
// provisioning defaults applied, plus the name the caller asked for.
export interface Binding extends BindingEntry {
  name: string;
}

export function resolveBinding(factoryRoot: string, name: string): Binding {
  const { bindings } = parseFactoryConfig(readFactoryConfigText(factoryRoot));
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
  const { service } = parseFactoryConfig(readFactoryConfigText(factoryRoot));
  return {
    slug: factorySlug(factoryRoot),
    port: service.port,
    serviceUrl: `http://localhost:${service.port}`,
    dashboardPort: service.dashboard_port,
    dashboardUrl: `http://localhost:${service.dashboard_port}`,
  };
}

// Writes `remote` and nothing else — the provisioning keys are the operator's
// to hand-edit. Returns the text unchanged when nothing moved, so a re-bind is
// byte-identical and every comment in the file survives.
export function upsertBinding(
  text: string,
  name: string,
  remote: string,
): string {
  const doc = parseDocument(text);
  if (doc.getIn(["bindings", name, "remote"]) === remote) return text;
  doc.setIn(["bindings", name, "remote"], remote);
  return stringify(doc);
}

export function removeBinding(text: string, name: string): string {
  const doc = parseDocument(text);
  if (!doc.hasIn(["bindings", name])) {
    const bound = Object.keys(parseFactoryConfig(text).bindings);
    throw new JigsError(
      `no binding named ${name}`,
      bound.length > 0 ? `bound: ${bound.join(", ")}` : "nothing is bound yet",
    );
  }
  doc.deleteIn(["bindings", name]);
  return stringify(doc);
}

// Unpadded flow collections, which is how the docs and the scaffolded
// jigs.yml write a `copy:` list: with the default padding a re-bind rewrites
// the operator's `[.env]` as `[ .env ]` just by passing through.
function stringify(doc: Document): string {
  return doc.toString({ flowCollectionPadding: false });
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
