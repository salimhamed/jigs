import type { McpServerConfig } from "../../../workflow/agents/harness-config.ts";

/** An MCP server as a harness launches it: credentials resolved to their values. */
export type ResolvedMcpServer =
  | { command: string; args?: string[]; env?: Record<string, string> }
  | { url: string; headers?: Record<string, string> };

export const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;

function namedEntries(server: McpServerConfig): { field: string; source: string }[] {
  if ("command" in server)
    return Object.entries(server.env ?? {}).map(([name, source]) => ({
      field: `env entry '${name}'`,
      source,
    }));
  return [
    ...Object.entries(server.headers ?? {}).map(([name, source]) => ({
      field: `header '${name}'`,
      source,
    })),
    ...(server.bearerTokenEnv === undefined
      ? []
      : [{ field: "bearerTokenEnv", source: server.bearerTokenEnv }]),
  ];
}

/** Every step-side variable the servers name, each once. */
export function mcpCredentialVariables(servers: Record<string, McpServerConfig>): string[] {
  return [
    ...new Set(
      Object.values(servers).flatMap((server) => namedEntries(server).map((e) => e.source)),
    ),
  ];
}

/**
 * Why a server's credentials cannot be resolved from `env`, or `undefined` when they can.
 * `missing` is the unset variable; a value is never included.
 */
export function mcpCredentialProblem(
  name: string,
  server: McpServerConfig,
  env: Record<string, string>,
): { reason: string; missing?: string } | undefined {
  if (!("command" in server) && server.bearerTokenEnv !== undefined) {
    const authorization = Object.keys(server.headers ?? {}).find(
      (header) => header.toLowerCase() === "authorization",
    );
    if (authorization !== undefined)
      return {
        reason: `MCP server '${name}' sets both bearerTokenEnv and header '${authorization}'; use one`,
      };
  }
  for (const { field, source } of namedEntries(server)) {
    // Such a value may be a secret, so it is not echoed.
    if (typeof source !== "string" || !ENV_NAME.test(source))
      return {
        reason: `MCP server '${name}' ${field} is not an environment variable name (uppercase letters, digits and underscores)`,
      };
    const value = env[source];
    if (value === undefined || value.trim() === "")
      return {
        reason: `MCP server '${name}' needs ${source}, which is not set in the service's environment`,
        missing: source,
      };
  }
  return undefined;
}

function resolved(values: Record<string, string> | undefined, env: Record<string, string>) {
  if (values === undefined) return undefined;
  return Object.fromEntries(
    Object.entries(values).map(([target, source]) => [target, env[source] ?? ""]),
  );
}

/** The server with each named variable replaced by its value in `env`. */
export function resolveMcpServer(
  server: McpServerConfig,
  env: Record<string, string>,
): ResolvedMcpServer {
  if ("command" in server) {
    const serverEnv = resolved(server.env, env);
    return {
      command: server.command,
      ...(server.args === undefined ? {} : { args: server.args }),
      ...(serverEnv === undefined ? {} : { env: serverEnv }),
    };
  }
  const headers = resolved(server.headers, env) ?? {};
  if (server.bearerTokenEnv !== undefined)
    headers.Authorization = `Bearer ${env[server.bearerTokenEnv] ?? ""}`;
  return {
    url: server.url,
    ...(Object.keys(headers).length === 0 ? {} : { headers }),
  };
}
