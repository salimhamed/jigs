import { expect, test } from "vitest";
import {
  mcpCredentialProblem,
  mcpCredentialVariables,
  resolveMcpServer,
} from "./mcp-credentials.ts";

const probe = { tool: "ping" };

test("stdio env values are resolved from the named step variables", () => {
  expect(
    resolveMcpServer(
      { command: "node", args: ["s.mjs"], env: { TOKEN: "PD_TOKEN" }, probe },
      { PD_TOKEN: "secret" },
    ),
  ).toEqual({ command: "node", args: ["s.mjs"], env: { TOKEN: "secret" } });
});

test("http header values are resolved from the named step variables", () => {
  expect(
    resolveMcpServer(
      { url: "https://mcp.example", headers: { "X-Api-Key": "API_KEY" }, probe },
      { API_KEY: "secret" },
    ),
  ).toEqual({ url: "https://mcp.example", headers: { "X-Api-Key": "secret" } });
});

test("bearerTokenEnv sets the Authorization header", () => {
  expect(
    resolveMcpServer(
      { url: "https://mcp.example", bearerTokenEnv: "PD_TOKEN", probe },
      { PD_TOKEN: "secret" },
    ),
  ).toEqual({ url: "https://mcp.example", headers: { Authorization: "Bearer secret" } });
});

test("a server without credentials resolves to its plain launch shape", () => {
  expect(resolveMcpServer({ command: "node", probe }, {})).toEqual({ command: "node" });
  expect(resolveMcpServer({ url: "https://mcp.example", probe }, {})).toEqual({
    url: "https://mcp.example",
  });
});

test("every referenced variable is listed once", () => {
  expect(
    mcpCredentialVariables({
      a: { command: "node", env: { A: "SHARED", B: "STDIO_ONLY" }, probe },
      b: { url: "https://x", headers: { h: "SHARED" }, bearerTokenEnv: "BEARER", probe },
    }),
  ).toEqual(["SHARED", "STDIO_ONLY", "BEARER"]);
});

test("an unset or blank variable is reported by name", () => {
  const server = { url: "https://x", bearerTokenEnv: "PD_TOKEN", probe };
  expect(mcpCredentialProblem("pd", server, {})).toEqual({
    reason: expect.stringContaining("PD_TOKEN"),
    missing: "PD_TOKEN",
  });
  expect(mcpCredentialProblem("pd", server, { PD_TOKEN: "  " })?.missing).toBe("PD_TOKEN");
  expect(mcpCredentialProblem("pd", server, { PD_TOKEN: "set" })).toBeUndefined();
});

test("a value that is not a variable name is rejected without echoing it", () => {
  const problem = mcpCredentialProblem(
    "pd",
    { url: "https://x", headers: { Authorization: "Token s3cr3t-value" }, probe },
    {},
  );
  expect(problem?.reason).toContain("Authorization");
  expect(problem?.missing).toBeUndefined();
  expect(JSON.stringify(problem)).not.toContain("s3cr3t");
});

test.each([
  ["a token literal", "ghp_abc123SECRETxyz"],
  ["a lowercase name", "pd_token"],
])("%s is rejected as not an environment variable name, without echoing it", (_label, value) => {
  const problem = mcpCredentialProblem(
    "pd",
    { command: "node", env: { TOKEN: value }, probe },
    { [value]: "set" },
  );
  expect(problem?.reason).toContain("not an environment variable name");
  expect(problem?.missing).toBeUndefined();
  expect(JSON.stringify(problem)).not.toContain(value);
});

test("bearerTokenEnv alongside an Authorization header in any case is a configuration failure", () => {
  const problem = mcpCredentialProblem(
    "pd",
    {
      url: "https://x",
      headers: { authorization: "PD_HEADER" },
      bearerTokenEnv: "PD_TOKEN",
      probe,
    },
    { PD_HEADER: "a", PD_TOKEN: "b" },
  );
  expect(problem?.reason).toContain("'authorization'");
  expect(problem?.reason).toContain("bearerTokenEnv");
  expect(JSON.stringify(problem)).not.toContain("PD_HEADER");
});
