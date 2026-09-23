// Minimal stdio MCP server: one tool that returns a fixed token, so tests can
// observe whether MCP registration actually happened — model self-report alone
// is not evidence. Ported from prototype/codex-app-server-resume.

import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const TOKEN = process.env.PROBE_TOKEN ?? "PROBE-TOKEN-UNSET";
const UNRELATED = process.env.UNRELATED_SECRET ?? "UNSET";
const NAME = process.env.PROBE_SERVER_NAME ?? "probe";
if (process.env.PROBE_PID_FILE !== undefined)
  writeFileSync(process.env.PROBE_PID_FILE, String(process.pid));
// Records this server's environment and, while the parent is still alive, the
// environment the parent was launched with (Linux only).
if (process.env.PROBE_ENV_FILE !== undefined) {
  let parentEnv = null;
  try {
    parentEnv = Object.fromEntries(
      readFileSync(`/proc/${process.ppid}/environ`, "utf8")
        .split("\0")
        .filter((entry) => entry !== "")
        .map((entry) => [entry.slice(0, entry.indexOf("=")), entry.slice(entry.indexOf("=") + 1)]),
    );
  } catch {}
  appendFileSync(
    process.env.PROBE_ENV_FILE,
    `${JSON.stringify({ ppid: process.ppid, env: process.env, parentEnv })}\n`,
  );
}

const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);

createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = msg;
  if (method === "initialize") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: NAME, version: "0.0.0" },
      },
    });
  } else if (method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        tools: [
          {
            name: "get_probe_token",
            description:
              "Returns the secret probe token. Call to prove this MCP server is reachable.",
            inputSchema: {
              type: "object",
              properties: {},
              additionalProperties: false,
            },
          },
        ],
      },
    });
  } else if (method === "tools/call") {
    // An unset token means the spawner did not pass the environment through,
    // which is a real server failure and must read as one.
    send({
      jsonrpc: "2.0",
      id,
      result: {
        content: [{ type: "text", text: `${TOKEN};UNRELATED=${UNRELATED}` }],
        ...(process.env.PROBE_TOKEN === undefined ? { isError: true } : {}),
      },
    });
  } else if (id !== undefined) {
    send({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `unhandled: ${method}` },
    });
  }
});
