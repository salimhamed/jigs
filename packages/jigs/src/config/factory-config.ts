import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseDocument } from "yaml";
import { z } from "zod";
import { CliError } from "../errors.ts";

export const FACTORY_CONFIG_FILE = "jigs.yml";

const bindingSchema = z.strictObject({
  path: z.string().min(1),
  remote: z.string().min(1),
  workspace_dir: z.string().min(1).optional(),
  ff_default_branch: z.boolean().default(true),
});

const factoryConfigSchema = z.looseObject({
  bindings: z.record(z.string(), bindingSchema).default({}),
  // Where provider webhooks reach this factory's service (the tunnel URL);
  // `jigs bind` skips its webhook leg while unset.
  ingress_url: z.url().optional(),
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
