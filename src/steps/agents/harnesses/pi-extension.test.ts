import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import {
  piMcpEnvironmentVariables,
  piMcpToolNames,
  writePiMcpExtension,
  writePiSubmitResultExtension,
} from "./pi-extension.ts";
import { makeTmpDir, removeTmpDir } from "./test-fixtures.ts";

vi.mock("pi-mcp-adapter", () => ({ createMcpAdapter: () => () => {} }));

let tmp: string | undefined;
afterEach(() => {
  if (tmp !== undefined) removeTmpDir(tmp);
});

test("submit_result extension is written inside the invocation home with the wire schema", () => {
  tmp = makeTmpDir();
  const schema = {
    type: "object",
    properties: { answer: { type: "string" } },
    required: ["answer"],
    additionalProperties: false,
  };
  const extension = writePiSubmitResultExtension(tmp, schema);

  expect(extension).toBe(path.join(tmp, "submit-result.ts"));
  const source = readFileSync(extension, "utf8");
  expect(source).toContain('name: "submit_result"');
  expect(source).toContain('constrainedSampling: { type: "json_schema", strict: "prefer" }');
  expect(source).toContain(`const schema = ${JSON.stringify(schema)};`);
  expect(source).toContain('import { Compile } from "typebox/compile";');
  expect(source).toContain("prepareArguments(args)");
  expect(source).toContain("details: params");
});

test("MCP extension supplies one complete direct-tools-only adapter snapshot", () => {
  tmp = makeTmpDir();
  const extension = writePiMcpExtension(tmp, {
    local: {
      command: "node",
      args: ["server.mjs"],
      env: { TOKEN: "LOCAL_MCP_TOKEN" },
      tools: ["ping"],
      probe: { tool: "ping" },
    },
    remote: {
      url: "https://mcp.example.test/api",
      auth: "oauth",
      headers: { "x-tenant": "MCP_TENANT" },
      tools: ["lookup"],
      probe: { tool: "lookup" },
    },
  });

  const source = readFileSync(extension, "utf8");
  expect(source).toContain('from "file:');
  expect(source).toContain("createMcpAdapter({ config:");
  expect(source).toContain('"local":{"command":"node","args":["server.mjs"]');
  expect(source).toContain('"env":{"TOKEN":"$env:LOCAL_MCP_TOKEN"}');
  expect(source).toContain('"inheritEnv":false');
  expect(source).toContain('"remote":{"url":"https://mcp.example.test/api"');
  expect(source).toContain('"auth":"oauth"');
  expect(source).toContain('"headers":{"x-tenant":"$env:MCP_TENANT"}');
  expect(source.match(/"exposeResources":false/g)).toHaveLength(2);
  expect(source).toContain('"lifecycle":"eager","directTools":["ping"],"includeTools":["ping"]');
  expect(source).toContain('"disableProxyTool":true');
  expect(source).toContain('"namespaceProxyTools":false');
  expect(source).toContain('"scriptMode":false');
  expect(source).toContain('"hostConfigDiscovery":"off"');
  expect(source).toContain('"ancestorConfigRoots":[]');
  expect(source).toContain('"agentPluginPaths":[]');
  expect(source).toContain('"jev":false');
  expect(source).toContain('active.filter((name) => name !== "mcp")');
  expect(source).toContain('pi.on("before_provider_request"');
  expect(source).toContain('event.toolName === "mcp"');
  expect(source).not.toContain("probe");
});

test("MCP extension removes the generic proxy from every provider tool shape", async () => {
  tmp = makeTmpDir();
  const extension = writePiMcpExtension(tmp, {
    local: { command: "node", tools: ["ping"], probe: { tool: "ping" } },
  });
  const handlers = new Map<string, (event: { payload: unknown }) => unknown>();
  const { default: register } = (await import(extension)) as {
    default: (pi: unknown) => void;
  };
  register({
    on: (name: string, handler: (event: { payload: unknown }) => unknown) =>
      handlers.set(name, handler),
    getActiveTools: () => [],
    setActiveTools: () => {},
  });
  const beforeRequest = handlers.get("before_provider_request");

  const payload = {
    tools: [
      { name: "mcp" },
      { name: "local_ping" },
      { type: "function", function: { name: "mcp" } },
      { functionDeclarations: [{ name: "mcp" }, { name: "local_ping" }] },
      { functionDeclarations: [{ name: "mcp" }] },
    ],
  };
  expect(beforeRequest?.({ payload })).toEqual({
    tools: [{ name: "local_ping" }, { functionDeclarations: [{ name: "local_ping" }] }],
  });
  const clean = { tools: [{ functionDeclarations: [{ name: "local_ping" }] }] };
  expect(beforeRequest?.({ payload: clean })).toBe(clean);
});

test("MCP helpers expose only environment names and Pi-visible direct tool names", () => {
  const servers = {
    "linear-personal": {
      command: "node",
      env: { TOKEN: "LINEAR_API_KEY" },
      tools: ["issues.lookup"],
      probe: { tool: "issues.lookup" },
    },
  };

  expect(piMcpEnvironmentVariables(servers)).toEqual(["LINEAR_API_KEY"]);
  expect(piMcpToolNames(servers)).toEqual(["linear-personal_issues_lookup"]);
});

test("MCP extension rejects unsupported transports before writing the extension", () => {
  tmp = makeTmpDir();
  expect(() =>
    writePiMcpExtension(tmp as string, {
      invalid: {
        command: "node",
        url: "https://mcp.example.test",
        tools: ["ping"],
        probe: { tool: "ping" },
      } as never,
    }),
  ).toThrow("must declare exactly one transport");
  expect(() =>
    writePiMcpExtension(tmp as string, {
      invalid: { url: "not a URL", tools: ["ping"], probe: { tool: "ping" } },
    }),
  ).toThrow("must declare an HTTP or HTTPS URL");
  expect(() =>
    writePiMcpExtension(tmp as string, {
      invalid: { command: "node", tools: ["other"], probe: { tool: "ping" } },
    }),
  ).toThrow("must allow its probe tool 'ping'");
  expect(() =>
    writePiMcpExtension(tmp as string, {
      invalid: {
        command: "node",
        headers: { authorization: "TOKEN" },
        tools: ["ping"],
        probe: { tool: "ping" },
      } as never,
    }),
  ).toThrow("declares unsupported field(s): headers");
  expect(() =>
    writePiMcpExtension(tmp as string, {
      invalid: {
        url: "ftp://mcp.example.test",
        tools: ["ping"],
        probe: { tool: "ping" },
      },
    }),
  ).toThrow("must declare an HTTP or HTTPS URL");
  expect(() =>
    writePiMcpExtension(tmp as string, {
      invalid: {
        command: "node",
        env: { TOKEN: "literal-secret" },
        tools: ["ping"],
        probe: { tool: "ping" },
      },
    }),
  ).toThrow("must name step-side environment variables");
  expect(() =>
    writePiMcpExtension(tmp as string, {
      invalid: {
        url: "https://mcp.example.test",
        bearerTokenEnv: "not-an-env-name",
        tools: ["ping"],
        probe: { tool: "ping" },
      },
    }),
  ).toThrow("bearerTokenEnv must name a step-side environment variable");
  expect(() =>
    writePiMcpExtension(tmp as string, {
      invalid: {
        url: "https://mcp.example.test",
        auth: "oauth",
        bearerTokenEnv: "TOKEN",
        tools: ["ping"],
        probe: { tool: "ping" },
      } as never,
    }),
  ).toThrow("cannot declare both auth and bearerTokenEnv");
});
