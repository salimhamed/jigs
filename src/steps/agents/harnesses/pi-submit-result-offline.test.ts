import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import semver from "semver";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { z } from "zod";
import { runAgent } from "../../../blocks/agents/agent.ts";
import { askAgent } from "../../../blocks/agents/ask-agent.ts";
import { harnesses, models } from "../../../blocks/agents/harness-config.ts";
import { executeAgent } from "../execute-agent.ts";
import { MIN_PI_VERSION, resolvePiExecutable } from "./executables.ts";
import { executePi } from "./pi.ts";
import { writePiSubmitResultExtension } from "./pi-extension.ts";
import { makeTmpDir, removeTmpDir } from "./test-fixtures.ts";

// These tests start the installed Pi against a scripted OpenAI-compatible
// server on localhost, so every model turn is deterministic and offline.

let tmp: string;
beforeEach(() => {
  tmp = makeTmpDir();
  vi.stubEnv("XDG_DATA_HOME", path.join(tmp, "data"));
  vi.stubEnv("NO_PROXY", "127.0.0.1,localhost");
});
afterEach(() => {
  vi.unstubAllEnvs();
  removeTmpDir(tmp);
});

function hasSupportedPi(): boolean {
  try {
    const answer = spawnSync(resolvePiExecutable(process.env), ["--version"], { encoding: "utf8" });
    const version = semver.coerce(`${answer.stdout}${answer.stderr}`, { includePrerelease: true });
    return answer.status === 0 && version !== null && semver.gte(version, MIN_PI_VERSION);
  } catch {
    return false;
  }
}

type ChatRequest = {
  messages: Array<Record<string, unknown>>;
  tools?: Array<{ function: { name: string; parameters: Record<string, unknown> } }>;
};
type Reply =
  | { text: string }
  | { call: Record<string, unknown> }
  | { calls: Array<Record<string, unknown>> };

function send(response: ServerResponse, reply: Reply): void {
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const calls = "text" in reply ? [] : "calls" in reply ? reply.calls : [reply.call];
  const delta =
    "text" in reply
      ? { role: "assistant", content: reply.text }
      : {
          role: "assistant",
          tool_calls: calls.map((call, index) => ({
            index,
            id: `call-${crypto.randomUUID()}`,
            type: "function",
            function: { name: "submit_result", arguments: JSON.stringify(call) },
          })),
        };
  const chunk = {
    id: "scripted",
    object: "chat.completion.chunk",
    created: 1,
    model: "scripted-model",
    choices: [{ index: 0, delta, finish_reason: "text" in reply ? "stop" : "tool_calls" }],
  };
  response.write(`data: ${JSON.stringify(chunk)}\n\n`);
  response.end("data: [DONE]\n\n");
}

// Answers the model listing jigs probes before a call, then each chat request
// with whatever `reply` decides from the request Pi sent.
async function scriptedModel(reply: (request: ChatRequest, index: number) => Reply) {
  const requests: ChatRequest[] = [];
  const server: Server = createServer((request: IncomingMessage, response) => {
    if (request.url?.endsWith("/models")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [{ id: "scripted-model" }] }));
      return;
    }
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      // A request whose client went away before sending its body is not a
      // turn. It is logged so a stray client stays visible.
      if (body === "") {
        console.warn(`scripted model ignored an empty ${request.method} ${request.url}`);
        response.end();
        return;
      }
      const parsed = JSON.parse(body) as ChatRequest;
      requests.push(parsed);
      send(response, reply(parsed, requests.length - 1));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("missing model port");
  const source = models.openaiCompatible({
    name: "scripted",
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    model: "scripted-model",
  });
  return {
    source,
    requests,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function writeScriptedHome(baseUrl: string): string {
  const home = path.join(tmp, `home-${crypto.randomUUID()}`);
  mkdirSync(home);
  const provider = {
    baseUrl,
    api: "openai-completions",
    apiKey: "offline",
    models: [{ id: "scripted-model", name: "Scripted" }],
  };
  writeFileSync(
    path.join(home, "models.json"),
    JSON.stringify({ providers: { scripted: provider } }),
  );
  writeFileSync(path.join(home, "settings.json"), JSON.stringify({ packages: [] }));
  return home;
}

const toolNames = (request: ChatRequest | undefined): string[] =>
  (request?.tools ?? []).map((tool) => tool.function.name);

const step = (wire: Parameters<typeof executeAgent>[0]) =>
  executeAgent(wire, { workflowRunId: `pi-submit-${crypto.randomUUID()}` });

const answer = z.object({ word: z.string(), count: z.number() });

test.skipIf(!hasSupportedPi())(
  "installed Pi tool flags: only --no-tools also hides extension tools",
  async () => {
    const model = await scriptedModel(() => ({ text: "ok" }));
    try {
      const extension = writePiSubmitResultExtension(tmp, {
        type: "object",
        properties: { ok: { type: "boolean" } },
        required: ["ok"],
        additionalProperties: false,
      });
      const cases: Array<[string[], string[]]> = [
        [["--no-tools"], []],
        [["--no-builtin-tools"], ["submit_result"]],
        [["--tools", "submit_result"], ["submit_result"]],
      ];
      for (const [flags] of cases) {
        await executePi({
          args: [
            "--mode",
            "json",
            ...flags,
            "--model",
            "scripted/scripted-model",
            "-ne",
            "-ns",
            "-np",
            "--no-themes",
            "-nc",
            "--no-approve",
            "-e",
            extension,
            "reply",
          ],
          cwd: tmp,
          env: {
            PATH: process.env.PATH ?? "",
            HOME: tmp,
            NO_PROXY: "127.0.0.1,localhost",
            PI_CODING_AGENT_DIR: writeScriptedHome(model.source.baseUrl),
          },
        });
      }
      expect(model.requests.map(toolNames)).toEqual(cases.map(([, tools]) => tools));
    } finally {
      await model.close();
    }
  },
  20_000,
);

test.skipIf(!hasSupportedPi())(
  "a structured Pi ask exposes only submit_result and returns its validated arguments",
  async () => {
    const model = await scriptedModel(() => ({ call: { word: "sky", count: 3 } }));
    try {
      const result = await askAgent(
        { harness: harnesses.pi(model.source), prompt: "Return sky and 3.", output: answer },
        step,
      );

      expect(result.output).toEqual({ word: "sky", count: 3 });
      expect(model.requests.map(toolNames)).toEqual([["submit_result"]]);
    } finally {
      await model.close();
    }
  },
  10_000,
);

test.skipIf(!hasSupportedPi())(
  "a structured Pi ask fails loudly when submit_result arguments do not match the schema",
  async () => {
    // "3" is what Pi's own argument coercion would silently turn into 3.
    const model = await scriptedModel((_request, index) =>
      index === 0 ? { call: { word: "sky", count: "3" } } : { text: "I could not comply." },
    );
    try {
      await expect(
        askAgent(
          { harness: harnesses.pi(model.source), prompt: "Return sky and 3.", output: answer },
          step,
        ),
      ).rejects.toThrow(
        /without an accepted submit_result call: submit_result arguments do not match the requested schema: \/count/,
      );
      expect(JSON.stringify(model.requests[1]?.messages)).toContain("do not match");
    } finally {
      await model.close();
    }
  },
  10_000,
);

test.skipIf(!hasSupportedPi())(
  "a structured Pi ask keeps the first accepted submit_result and rejects later calls",
  async () => {
    const model = await scriptedModel((_request, index) =>
      index === 0
        ? {
            calls: [
              { word: "sky", count: 3 },
              { word: "sea", count: 4 },
            ],
          }
        : { text: "done" },
    );
    try {
      const result = await askAgent(
        { harness: harnesses.pi(model.source), prompt: "Return sky and 3.", output: answer },
        step,
      );

      expect(result.output).toEqual({ word: "sky", count: 3 });
      expect(JSON.stringify(model.requests[1]?.messages)).toContain("already submitted");
    } finally {
      await model.close();
    }
  },
  10_000,
);

test.skipIf(!hasSupportedPi())(
  "a structured Pi ask never accepts JSON-looking text in place of submit_result",
  async () => {
    const model = await scriptedModel(() => ({ text: '{"word":"sky","count":3}' }));
    try {
      await expect(
        askAgent(
          { harness: harnesses.pi(model.source), prompt: "Return sky and 3.", output: answer },
          step,
        ),
      ).rejects.toThrow("pi finished without calling submit_result");
    } finally {
      await model.close();
    }
  },
  10_000,
);

test.skipIf(!hasSupportedPi())(
  "a plain Pi ask sends no tools and returns text",
  async () => {
    const model = await scriptedModel(() => ({ text: '{"looks":"like json"}' }));
    try {
      const result = await askAgent({ harness: harnesses.pi(model.source), prompt: "Hi" }, step);

      expect(result).toEqual({ text: '{"looks":"like json"}', output: undefined });
      expect(model.requests.map(toolNames)).toEqual([[]]);
    } finally {
      await model.close();
    }
  },
  10_000,
);

test.skipIf(!hasSupportedPi())(
  "a structured Pi run adds submit_result to the caller's tool allowlist",
  async () => {
    const worktree = path.join(tmp, "worktree");
    mkdirSync(worktree);
    const model = await scriptedModel(() => ({ call: { word: "sky", count: 3 } }));
    try {
      const result = await runAgent(
        {
          harness: harnesses.pi(model.source, { tools: ["read"] }),
          cwd: worktree,
          prompt: "Return sky and 3.",
          output: answer,
        },
        step,
      );

      expect(result.output).toEqual({ word: "sky", count: 3 });
      expect(model.requests.map(toolNames)).toEqual([["read", "submit_result"]]);
    } finally {
      await model.close();
    }
  },
  10_000,
);

test.skipIf(!hasSupportedPi())(
  "concurrent structured Pi asks each validate against their own schema",
  async () => {
    const wordOnly = z.object({ word: z.string() });
    const countOnly = z.object({ count: z.number() });
    // Each request is answered with the other call's arguments first, so a
    // shared or crossed extension would accept them.
    const model = await scriptedModel((request) => {
      const parameters = request.tools?.[0]?.function.parameters as {
        properties: Record<string, unknown>;
      };
      const wantsWord = "word" in parameters.properties;
      const toolResults = request.messages.filter((message) => message.role === "tool");
      if (toolResults.length === 0) return { call: wantsWord ? { count: 3 } : { word: "sky" } };
      return { call: wantsWord ? { word: "sky" } : { count: 3 } };
    });
    try {
      const [word, count] = await Promise.all([
        askAgent({ harness: harnesses.pi(model.source), prompt: "word", output: wordOnly }, step),
        askAgent({ harness: harnesses.pi(model.source), prompt: "count", output: countOnly }, step),
      ]);

      expect(word.output).toEqual({ word: "sky" });
      expect(count.output).toEqual({ count: 3 });
      expect(model.requests).toHaveLength(4);
    } finally {
      await model.close();
    }
  },
  15_000,
);
