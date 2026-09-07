import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";

// The factory repo's `.env`: the one file setup tells the operator to fill in.
// It is the service child's environment, and the CLI verbs that need a
// credential of their own read it from here rather than from the shell alone.
// Absent is empty — which slot matters is the caller's to say.
export function readFactoryEnv(factoryRoot: string): Record<string, string> {
  const file = path.join(factoryRoot, ".env");
  if (!existsSync(file)) return {};
  return parseEnv(readFileSync(file, "utf8")) as Record<string, string>;
}

// The shell wins: exporting a value for a single command is how an operator
// overrides the factory's own. Empty counts as unset on either side.
export function factoryEnvValue(
  factoryRoot: string,
  key: string,
): string | undefined {
  const exported = process.env[key];
  if (exported !== undefined && exported !== "") return exported;
  const declared = readFactoryEnv(factoryRoot)[key];
  return declared === undefined || declared === "" ? undefined : declared;
}
