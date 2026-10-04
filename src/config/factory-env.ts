import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";

export function readFactoryEnv(factoryRoot: string): Record<string, string> {
  const file = path.join(factoryRoot, ".env");
  if (!existsSync(file)) return {};
  return parseEnv(readFileSync(file, "utf8")) as Record<string, string>;
}
