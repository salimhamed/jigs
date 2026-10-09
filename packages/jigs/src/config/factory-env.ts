import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";

export function readFactoryEnv(factoryRoot: string): Record<string, string> {
  const file = path.join(factoryRoot, ".env");
  if (!existsSync(file)) return {};
  return parseEnv(readFileSync(file, "utf8")) as Record<string, string>;
}

/** Set one variable in the factory's existing `.env`, replacing its line or adding one. */
export function setFactoryEnv(factoryRoot: string, name: string, value: string): void {
  const file = path.join(factoryRoot, ".env");
  const text = readFileSync(file, "utf8");
  const line = `${name}=${value}`;
  const pattern = new RegExp(`^${name}=.*$`, "m");
  writeFileSync(
    file,
    pattern.test(text)
      ? text.replace(pattern, () => line)
      : `${text}${text === "" || text.endsWith("\n") ? "" : "\n"}${line}\n`,
  );
}
