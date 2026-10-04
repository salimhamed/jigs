import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const main = fileURLToPath(new URL("./main.ts", import.meta.url));

test("serves /health and exits cleanly on SIGTERM", async () => {
  const child = spawn(process.execPath, [main], {
    env: { ...process.env, PORT: "0", HOST: "127.0.0.1" },
    stdio: ["ignore", "pipe", "inherit"],
  });
  const [line] = await once(child.stdout, "data");
  const url = /http:\/\/\S+/.exec(String(line))?.[0];
  expect(url).toBeDefined();

  const health = await fetch(`${url}/health`);
  expect(health.status).toBe(200);
  expect(await health.json()).toEqual({ status: "ok" });
  expect((await fetch(`${url}/missing`)).status).toBe(404);

  child.kill("SIGTERM");
  const [code, signal] = await once(child, "exit");
  expect({ code, signal }).toEqual({ code: 0, signal: null });
});
