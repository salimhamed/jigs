import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { JigsError } from "../errors.ts";
import {
  type Binding,
  FACTORY_CONFIG_FILE,
  type FactoryConfig,
  parseFactoryConfig,
} from "../workflow/factory-schema.ts";
import type { FactoryContext } from "./factory-context.ts";

const require = createRequire(import.meta.url);

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

export function resolveBinding(config: FactoryConfig, name: string): Binding {
  const { bindings } = config;
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
  dashboardUrl: string;
}

// What is addressed per factory: the URL its CLI verbs talk to and the slug
// that keys its service record and its bindings' directories.
export function resolveService(ctx: FactoryContext): ResolvedService {
  const port = requiredPort(ctx, "JIGS_SERVICE_PORT");
  return {
    slug: ctx.slug,
    port,
    serviceUrl: `http://localhost:${port}`,
    dashboardUrl: `http://localhost:${requiredPort(ctx, "JIGS_DASHBOARD_PORT")}`,
  };
}

function requiredPort(ctx: FactoryContext, name: string): number {
  const value = ctx.env(name);
  if (value === undefined) throw new JigsError(`${name} is not set`);
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new JigsError(`${name} is not a port`);
  }
  return port;
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
