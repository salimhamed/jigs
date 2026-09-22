import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import path from "node:path";
import semver from "semver";
import { afterEach, beforeEach, expect, test } from "vitest";
import { MIN_PI_VERSION, resolvePiExecutable } from "./executables.ts";
import { executePi, type PiExecutionOptions } from "./pi.ts";
import { makeTmpDir, removeTmpDir } from "./test-fixtures.ts";

let tmp: string;
beforeEach(() => {
  tmp = makeTmpDir();
});
afterEach(() => removeTmpDir(tmp));

function hasSupportedPi(): boolean {
  try {
    const executable = resolvePiExecutable(process.env);
    const answer = spawnSync(executable, ["--version"], { encoding: "utf8" });
    if (answer.status !== 0) return false;
    const version = semver.coerce(`${answer.stdout}${answer.stderr}`, { includePrerelease: true });
    return version !== null && semver.gte(version, MIN_PI_VERSION);
  } catch {
    return false;
  }
}

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  );
}

async function executeWithDeadline(
  options: PiExecutionOptions,
  server: Server,
): Promise<Awaited<ReturnType<typeof executePi>>> {
  const execution = executePi(options);
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      void closeServer(server);
      reject(new Error("offline Pi subprocess did not exit"));
    }, 5_000);
  });
  try {
    return await Promise.race([execution, deadline]);
  } catch (error) {
    if (timedOut) await execution.catch(() => undefined);
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function writeScriptedPiHome(port: number): string {
  const home = path.join(tmp, "pi-home");
  mkdirSync(home);
  writeFileSync(
    path.join(home, "models.json"),
    JSON.stringify({
      providers: {
        scripted: {
          baseUrl: `http://127.0.0.1:${port}/v1`,
          api: "openai-completions",
          apiKey: "offline-test",
          models: [
            {
              id: "retry-model",
              name: "Retry model",
              contextWindow: 8192,
              maxTokens: 1024,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              compat: { supportsDeveloperRole: true },
            },
          ],
        },
      },
    }),
  );
  writeFileSync(
    path.join(home, "settings.json"),
    JSON.stringify({
      packages: [],
      retry: { enabled: true, maxRetries: 1, baseDelayMs: 0, maxAgentDelayMs: 0 },
      providerRetry: { maxRetries: 0, maxRetryDelayMs: 0 },
    }),
  );
  return home;
}

function piOptions(home: string) {
  return {
    args: [
      "--mode",
      "json",
      "--no-tools",
      "--model",
      "scripted/retry-model",
      "--session-dir",
      path.join(tmp, "sessions"),
      "-ne",
      "-ns",
      "-np",
      "--no-themes",
      "-nc",
      "--no-approve",
      "reply once",
    ],
    cwd: tmp,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: tmp,
      PI_CODING_AGENT_DIR: home,
      NO_PROXY: "127.0.0.1,localhost",
    },
  };
}

test.skipIf(!hasSupportedPi())(
  "installed Pi retries a scripted endpoint and exits with one settled success",
  async () => {
    let requests = 0;
    const server = createServer((_request, response) => {
      requests += 1;
      if (requests === 1) {
        response.writeHead(503, { "content-type": "application/json" });
        response.end(
          JSON.stringify({ error: { message: "temporary scripted outage", type: "server_error" } }),
        );
        return;
      }

      response.writeHead(200, {
        "content-type": "text/event-stream",
        connection: "keep-alive",
        "cache-control": "no-cache",
      });
      const chunk = (delta: Record<string, unknown>, finishReason: string | null) =>
        `data: ${JSON.stringify({
          id: "scripted-response",
          object: "chat.completion.chunk",
          created: 1,
          model: "retry-model",
          choices: [{ index: 0, delta, finish_reason: finishReason }],
        })}\n\n`;
      response.write(chunk({ role: "assistant", content: "retry recovered" }, null));
      response.write(chunk({}, "stop"));
      response.end("data: [DONE]\n\n");
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = server.address();
      if (address === null || typeof address === "string")
        throw new Error("scripted server has no port");
      const generation = await executeWithDeadline(
        piOptions(writeScriptedPiHome(address.port)),
        server,
      );

      expect(requests).toBeGreaterThan(1);
      expect(generation.text).toBe("retry recovered");
    } finally {
      await closeServer(server);
    }
  },
  10_000,
);

test.skipIf(!hasSupportedPi())(
  "installed Pi exhausts its native retry and reports the settled model error",
  async () => {
    let requests = 0;
    const server = createServer((_request, response) => {
      requests += 1;
      response.writeHead(503, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ error: { message: "persistent scripted outage", type: "server_error" } }),
      );
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = server.address();
      if (address === null || typeof address === "string")
        throw new Error("scripted server has no port");

      await expect(
        executeWithDeadline(piOptions(writeScriptedPiHome(address.port)), server),
      ).rejects.toThrow("persistent scripted outage");
      expect(requests).toBeGreaterThan(1);
    } finally {
      await closeServer(server);
    }
  },
  10_000,
);
