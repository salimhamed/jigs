import { JigsError } from "../errors.ts";
import type { PiMcpServerConfig } from "./harness-config.ts";

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SERVER_NAME = /^[A-Za-z0-9_-]+$/;
const STDIO_FIELDS = ["command", "args", "env", "probe", "tools"];
const HTTP_FIELDS = ["url", "headers", "auth", "bearerTokenEnv", "probe", "tools"];
const HINT = "fix the server in the Pi harness's mcpServers";

const strings = (values: unknown): boolean =>
  Object.values(values ?? {}).every((value) => typeof value === "string");
const envNames = (values: Record<string, string> | undefined): boolean =>
  Object.values(values ?? {}).every((source) => ENV_NAME.test(source));

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.username === "" &&
      url.password === ""
    );
  } catch {
    return false;
  }
}

function problem(name: string, server: PiMcpServerConfig): string | undefined {
  if (!SERVER_NAME.test(name)) return "must use only letters, numbers, '_' or '-'";
  if (typeof server !== "object" || server === null || Array.isArray(server))
    return "must be an object";
  if (
    !Array.isArray(server.tools) ||
    server.tools.length === 0 ||
    server.tools.some((tool) => typeof tool !== "string" || tool.trim() === "")
  )
    return "must allow at least one named tool";
  if (
    typeof server.probe !== "object" ||
    server.probe === null ||
    typeof server.probe.tool !== "string" ||
    server.probe.tool === ""
  )
    return "must declare a probe tool";
  if ("disabledTools" in server)
    return "sets disabledTools; Pi exposes only its tools list, so leave the tools out of that instead";
  if (!server.tools.includes(server.probe.tool))
    return `must allow its probe tool '${server.probe.tool}'`;
  if ("command" in server) {
    if ("url" in server) return "must declare exactly one transport";
    const unsupported = Object.keys(server).filter((key) => !STDIO_FIELDS.includes(key));
    if (unsupported.length > 0) return `declares unsupported field(s): ${unsupported.join(", ")}`;
    if (typeof server.command !== "string" || server.command.trim() === "")
      return "must declare a non-empty command";
    if (server.args !== undefined && !server.args.every((arg) => typeof arg === "string"))
      return "args must contain only strings";
    if (!strings(server.env)) return "env must contain only strings";
    if (!envNames(server.env)) return "env values must name step-side environment variables";
    return undefined;
  }
  const unsupported = Object.keys(server).filter((key) => !HTTP_FIELDS.includes(key));
  if (unsupported.length > 0) return `declares unsupported field(s): ${unsupported.join(", ")}`;
  if (typeof server.url !== "string" || server.url.trim() === "")
    return "must declare a non-empty URL";
  if (server.bearerTokenEnv !== undefined && server.auth !== undefined)
    return "cannot declare both auth and bearerTokenEnv";
  if (
    server.bearerTokenEnv !== undefined &&
    (typeof server.bearerTokenEnv !== "string" || !ENV_NAME.test(server.bearerTokenEnv))
  )
    return "bearerTokenEnv must name a step-side environment variable";
  if (!isHttpUrl(server.url)) return "must declare an HTTP or HTTPS URL";
  if (server.auth !== undefined && server.auth !== "oauth" && server.auth !== false)
    return "declares unsupported authentication";
  if (!strings(server.headers)) return "headers must contain only strings";
  if (!envNames(server.headers)) return "header values must name step-side environment variables";
  return undefined;
}

/** Reject a Pi MCP server the pinned adapter cannot represent. */
export function assertPiMcpServers(servers: Record<string, PiMcpServerConfig>): void {
  for (const [name, server] of Object.entries(servers)) {
    const found = problem(name, server);
    if (found !== undefined) throw new JigsError(`Pi MCP server '${name}' ${found}`, HINT);
  }
}
