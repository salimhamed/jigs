import { type FactoryContext, processEnv } from "../config/factory-context.ts";
import { readFactoryEnv } from "../config/factory-env.ts";
import { RESTART_SERVICE, SERVICE_ENV_FILE } from "../providers/credentials.ts";
import { ENV_NAME, mcpCredentialVariables } from "../steps/agents/shared/mcp-credentials.ts";
import { neededByUsers, type WorkflowManifests } from "./catalog.ts";
import { type Check, failedCheck } from "./check.ts";
import type { WorkflowRequires } from "./index.ts";

export interface SecretChecksOptions {
  context: FactoryContext;
  env?: Record<string, string | undefined>;
}

// An invalid MCP credential name is the MCP server check's diagnosis, in
// doctor and when the step starts.
function secretNames(requires: WorkflowRequires, mcpCredentials = true): string[] {
  const mcp = mcpCredentials
    ? Object.values(requires.agents ?? {}).flatMap((harness) =>
        mcpCredentialVariables(harness.mcpServers ?? {}),
      )
    : [];
  return [
    ...new Set([
      ...(requires.secrets ?? []).filter((name) => ENV_NAME.test(name)),
      ...mcp.filter((name) => ENV_NAME.test(name)),
    ]),
  ];
}

// Entries are identified by position: one that is not a name may be a value.
function invalidEntries(requires: WorkflowRequires): number[] {
  return (requires.secrets ?? []).flatMap((name, index) =>
    typeof name === "string" && ENV_NAME.test(name) ? [] : [index + 1],
  );
}

function invalidEntriesCheck(id: string, list: string, entries: number[]): Check {
  const one = entries.length === 1;
  return failedCheck(
    id,
    "requires.secrets",
    `${one ? "entry" : "entries"} ${entries.join(", ")} of ${list} ${one ? "is not an environment variable name" : "are not environment variable names"} (uppercase letters, digits and underscores)`,
    "list variable names in requires.secrets, never values, then: `pnpm exec jigs up`",
  );
}

// The service starts with the shell's environment overlaid by every non-empty
// line of `.env`, so a value here with none in `.env` came from the shell.
function secretCheck(name: string, options: SecretChecksOptions): Check {
  return {
    id: `secret.${name}`,
    label: `secret ${name}`,
    run: async () => {
      const value = (options.env ?? processEnv())[name];
      if (value === undefined || value.trim() === "")
        return {
          ok: false,
          reason: `${name} is not set in the service's environment`,
          repair: `set ${name} in ${SERVICE_ENV_FILE}, then: \`${RESTART_SERVICE}\``,
        };
      let declared: string | undefined;
      try {
        declared = readFactoryEnv(options.context.root)[name];
      } catch {
        return { ok: true };
      }
      return declared === undefined || declared.trim() === ""
        ? {
            ok: true,
            detail: "not set in .env; the service has it from the shell or an earlier .env",
          }
        : { ok: true };
    },
  };
}

/** One workflow's secrets, as preflight checks them before a run. */
export function secretChecks(requires: WorkflowRequires, options: SecretChecksOptions): Check[] {
  const invalid = invalidEntries(requires);
  return [
    ...(invalid.length > 0
      ? [invalidEntriesCheck("secret.entries", "requires.secrets", invalid)]
      : []),
    ...secretNames(requires).map((name) => secretCheck(name, options)),
  ];
}

/**
 * Every workflow's declared secrets, one check per name naming the workflows that need it.
 * Doctor's MCP server checks already report a missing MCP credential.
 */
export function doctorSecretChecks(
  workflows: WorkflowManifests,
  options: SecretChecksOptions,
): Check[] {
  const invalid: Check[] = [];
  const users = new Map<string, string[]>();
  for (const [workflow, { requires = {} }] of Object.entries(workflows)) {
    const entries = invalidEntries(requires);
    if (entries.length > 0)
      invalid.push(
        invalidEntriesCheck(
          `secret.entries.${workflow}`,
          `workflow ${workflow}'s requires.secrets`,
          entries,
        ),
      );
    for (const name of secretNames(requires, false))
      users.set(name, [...(users.get(name) ?? []), workflow]);
  }
  return [
    ...invalid,
    ...[...users].flatMap(([name, needing]) =>
      neededByUsers([secretCheck(name, options)], needing),
    ),
  ];
}
