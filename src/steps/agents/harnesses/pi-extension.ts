import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { formatToolName } from "pi-mcp-adapter/types";
import type { PiMcpServerConfig } from "../../../blocks/agents/harness-config.ts";
import type { OutputJsonSchema } from "../../../blocks/agents/output-schema.ts";

type PiMcpServer = {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  inheritEnv?: false;
  url?: string;
  headers?: Record<string, string>;
  auth?: "oauth" | false;
  bearerTokenEnv?: string;
  exposeResources: false;
  lifecycle: "eager";
  directTools: string[];
  includeTools: string[];
};

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SERVER_NAME = /^[A-Za-z0-9_-]+$/;

function environmentSnapshot(values: Record<string, string> | undefined) {
  if (values === undefined) return undefined;
  return Object.fromEntries(
    Object.entries(values).map(([name, source]) => [name, `$env:${source}`]),
  );
}

function piMcpServers(servers: Record<string, PiMcpServerConfig>): Record<string, PiMcpServer> {
  return Object.fromEntries(
    Object.entries(servers).map(([name, server]) => {
      if (!SERVER_NAME.test(name))
        throw new Error(`Pi MCP server '${name}' must use only letters, numbers, '_' or '-'`);
      if (typeof server !== "object" || server === null || Array.isArray(server))
        throw new Error(`Pi MCP server '${name}' must be an object`);
      if (
        !Array.isArray(server.tools) ||
        server.tools.length === 0 ||
        server.tools.some((tool) => typeof tool !== "string" || tool.trim() === "")
      )
        throw new Error(`Pi MCP server '${name}' must allow at least one named tool`);
      if (
        typeof server.probe !== "object" ||
        server.probe === null ||
        typeof server.probe.tool !== "string" ||
        server.probe.tool === ""
      )
        throw new Error(`Pi MCP server '${name}' must declare a probe tool`);
      if (!server.tools.includes(server.probe.tool))
        throw new Error(`Pi MCP server '${name}' must allow its probe tool '${server.probe.tool}'`);
      if ("command" in server) {
        if ("url" in server)
          throw new Error(`Pi MCP server '${name}' must declare exactly one transport`);
        const unsupported = Object.keys(server).filter(
          (key) => !["command", "args", "env", "probe", "tools"].includes(key),
        );
        if (unsupported.length > 0)
          throw new Error(
            `Pi MCP server '${name}' declares unsupported field(s): ${unsupported.join(", ")}`,
          );
        if (typeof server.command !== "string" || server.command.trim() === "")
          throw new Error(`Pi MCP server '${name}' must declare a non-empty command`);
        if (server.args !== undefined && !server.args.every((arg) => typeof arg === "string"))
          throw new Error(`Pi MCP server '${name}' args must contain only strings`);
        if (
          server.env !== undefined &&
          Object.values(server.env).some((value) => typeof value !== "string")
        )
          throw new Error(`Pi MCP server '${name}' env must contain only strings`);
        if (Object.values(server.env ?? {}).some((source) => !ENV_NAME.test(source)))
          throw new Error(
            `Pi MCP server '${name}' env values must name step-side environment variables`,
          );
        return [
          name,
          {
            command: server.command,
            ...(server.args === undefined ? {} : { args: server.args }),
            ...(server.env === undefined ? {} : { env: environmentSnapshot(server.env) }),
            inheritEnv: false,
            exposeResources: false,
            lifecycle: "eager",
            directTools: server.tools,
            includeTools: server.tools,
          },
        ];
      }
      const unsupported = Object.keys(server).filter(
        (key) => !["url", "headers", "auth", "bearerTokenEnv", "probe", "tools"].includes(key),
      );
      if (unsupported.length > 0)
        throw new Error(
          `Pi MCP server '${name}' declares unsupported field(s): ${unsupported.join(", ")}`,
        );
      if (typeof server.url !== "string" || server.url.trim() === "")
        throw new Error(`Pi MCP server '${name}' must declare a non-empty URL`);
      if (server.bearerTokenEnv !== undefined && server.auth !== undefined)
        throw new Error(`Pi MCP server '${name}' cannot declare both auth and bearerTokenEnv`);
      if (
        server.bearerTokenEnv !== undefined &&
        (typeof server.bearerTokenEnv !== "string" || !ENV_NAME.test(server.bearerTokenEnv))
      )
        throw new Error(
          `Pi MCP server '${name}' bearerTokenEnv must name a step-side environment variable`,
        );
      try {
        const url = new URL(server.url);
        if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error();
        if (url.username !== "" || url.password !== "") throw new Error();
      } catch {
        throw new Error(`Pi MCP server '${name}' must declare an HTTP or HTTPS URL`);
      }
      if (server.auth !== undefined && server.auth !== "oauth" && server.auth !== false)
        throw new Error(`Pi MCP server '${name}' declares unsupported authentication`);
      if (
        server.headers !== undefined &&
        Object.values(server.headers).some((value) => typeof value !== "string")
      )
        throw new Error(`Pi MCP server '${name}' headers must contain only strings`);
      if (Object.values(server.headers ?? {}).some((source) => !ENV_NAME.test(source)))
        throw new Error(
          `Pi MCP server '${name}' header values must name step-side environment variables`,
        );
      return [
        name,
        {
          url: server.url,
          ...(server.headers === undefined ? {} : { headers: environmentSnapshot(server.headers) }),
          ...(server.auth === undefined ? {} : { auth: server.auth }),
          ...(server.bearerTokenEnv === undefined
            ? {}
            : { auth: "bearer" as const, bearerTokenEnv: server.bearerTokenEnv }),
          exposeResources: false,
          lifecycle: "eager",
          directTools: server.tools,
          includeTools: server.tools,
        },
      ];
    }),
  );
}

/** Write the isolated MCP adapter extension for one Pi invocation. */
export function writePiMcpExtension(
  home: string,
  servers: Record<string, PiMcpServerConfig>,
): string {
  const extension = path.join(home, "mcp-adapter.ts");
  const adapterUrl = pathToFileURL(createRequire(import.meta.url).resolve("pi-mcp-adapter")).href;
  const config = {
    mcpServers: piMcpServers(servers),
    settings: {
      directTools: true,
      disableProxyTool: true,
      namespaceProxyTools: false,
      scriptMode: false,
      hostConfigDiscovery: "off",
      ancestorConfigRoots: [],
      agentPluginPaths: [],
      jev: false,
      notifyOnStartupConnect: false,
      mcpFooterStatus: "off",
    },
  };
  writeFileSync(
    extension,
    `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createMcpAdapter } from ${JSON.stringify(adapterUrl)};

const adapter = createMcpAdapter({ config: ${JSON.stringify(config)} });

export default function (pi: ExtensionAPI) {
  adapter(pi);
  const disableProxy = () => {
    const active = pi.getActiveTools();
    if (active.includes("mcp")) pi.setActiveTools(active.filter((name) => name !== "mcp"));
  };
  pi.on("before_agent_start", disableProxy);
  pi.on("turn_start", disableProxy);
  pi.on("before_provider_request", (event) => {
    if (typeof event.payload !== "object" || event.payload === null || Array.isArray(event.payload))
      return event.payload;
    const payload = event.payload as Record<string, unknown>;
    if (!Array.isArray(payload.tools)) return event.payload;
    let changed = false;
    const tools = payload.tools.flatMap((tool) => {
      if (typeof tool !== "object" || tool === null || Array.isArray(tool)) return [tool];
      const record = tool as {
        name?: unknown;
        function?: { name?: unknown };
        functionDeclarations?: unknown;
      };
      if (record.name === "mcp" || record.function?.name === "mcp") {
        changed = true;
        return [];
      }
      if (!Array.isArray(record.functionDeclarations)) return [tool];
      const functionDeclarations = record.functionDeclarations.filter(
        (declaration) => (declaration as { name?: unknown } | null)?.name !== "mcp",
      );
      if (functionDeclarations.length === record.functionDeclarations.length) return [tool];
      changed = true;
      return functionDeclarations.length === 0 ? [] : [{ ...record, functionDeclarations }];
    });
    return changed ? { ...payload, tools } : event.payload;
  });
  pi.on("tool_call", (event) =>
    event.toolName === "mcp"
      ? { block: true, reason: "The generic MCP proxy is disabled for this invocation" }
      : undefined,
  );
}
`,
  );
  return extension;
}

/** Reject Pi MCP shapes that cannot be represented by the pinned adapter. */
export function validatePiMcpServers(servers: Record<string, PiMcpServerConfig>): void {
  piMcpServers(servers);
  const names = piMcpToolNames(servers);
  if (new Set(names).size !== names.length)
    throw new Error("Pi MCP direct tool names must be unique after adapter prefixing");
}

/** Return the host variables referenced by one explicit Pi MCP snapshot. */
export function piMcpEnvironmentVariables(servers: Record<string, PiMcpServerConfig>): string[] {
  const names = new Set<string>();
  for (const server of Object.values(servers)) {
    if ("command" in server) {
      for (const name of Object.values(server.env ?? {})) names.add(name);
      continue;
    }
    for (const name of Object.values(server.headers ?? {})) names.add(name);
    if (server.bearerTokenEnv !== undefined) names.add(server.bearerTokenEnv);
  }
  return [...names];
}

/** Return the Pi-visible names of every explicitly allowed direct MCP tool. */
export function piMcpToolNames(servers: Record<string, PiMcpServerConfig>): string[] {
  return Object.entries(servers).flatMap(([server, config]) =>
    config.tools.map((tool) => formatToolName(tool, server, "server")),
  );
}

/** The structured-result tool the Pi driver loads when a request has an output schema. */
export const SUBMIT_RESULT_TOOL = "submit_result";

/**
 * Write the structured-result tool for one Pi invocation. It accepts only
 * arguments that already match the requested schema, and only the first
 * accepted call: any later call is rejected so the first result stands.
 */
export function writePiSubmitResultExtension(home: string, schema: OutputJsonSchema): string {
  const extension = path.join(home, "submit-result.ts");
  writeFileSync(
    extension,
    `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Compile } from "typebox/compile";

const schema = ${JSON.stringify(schema)};
const validator = Compile(schema);
const tool = ${JSON.stringify(SUBMIT_RESULT_TOOL)};
let submitted = false;

function rejectRepeatedSubmission() {
  if (submitted) {
    throw new Error(\`A result was already submitted and it stands; do not call \${tool} again.\`);
  }
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: tool,
    label: "Submit result",
    description: "Submit the final structured answer.",
    promptSnippet: "Submit the final structured answer",
    promptGuidelines: [\`Use \${tool} as your final action and do not answer afterward.\`],
    parameters: Type.Unsafe(schema),
    // Many OpenAI-compatible servers lack strict tool schemas; the check below
    // enforces the schema wherever constrained sampling is unavailable.
    constrainedSampling: { type: "json_schema", strict: "prefer" },
    // Pi coerces arguments (such as "3" to 3) before its own check, so the
    // model's raw arguments are validated here first.
    prepareArguments(args) {
      rejectRepeatedSubmission();
      if (validator.Check(args)) return args;
      const problems = validator
        .Errors(args)
        .map((error) => \`\${error.instancePath || "/"} \${error.message}\`);
      throw new Error(
        \`\${tool} arguments do not match the requested schema: \${problems.join("; ")}\`,
      );
    },
    async execute(_toolCallId, params) {
      // Calls in one parallel batch are all prepared before any executes.
      rejectRepeatedSubmission();
      submitted = true;
      return {
        content: [{ type: "text", text: "Structured result submitted" }],
        details: params,
        terminate: true,
      };
    },
  });
}
`,
  );
  return extension;
}
