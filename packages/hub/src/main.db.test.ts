import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { afterEach, expect } from "vitest";
import { createTestDatabase, dbTest } from "./db/test-database.ts";

const main = fileURLToPath(new URL("../dist/main.js", import.meta.url));
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

dbTest("migrates, serves the built web app and exits cleanly on SIGTERM", async () => {
  const database = await createTestDatabase();
  cleanups.push(database.drop);
  const child = spawn(process.execPath, [main], {
    env: {
      ...process.env,
      NODE_ENV: "production",
      HOST: "127.0.0.1",
      PORT: "0",
      HUB_PUBLIC_URL: "https://hub.example.com",
      HUB_DATABASE_URL: database.url,
      HUB_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
  cleanups.push(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await once(child, "exit");
    }
  });
  const [line] = await once(child.stdout, "data");
  const url = /http:\/\/\S+/.exec(String(line))?.[0];
  expect(url).toBeDefined();

  const health = await fetch(`${url}/health`);
  expect(health.status).toBe(200);
  expect(await health.json()).toEqual({ status: "ok" });

  const home = await fetch(`${url}/`);
  expect(home.status).toBe(200);
  const html = await home.text();
  expect(html).toContain("https://hub.example.com/");
  const asset = /href="(\/assets\/[^"]+\.js)"/.exec(html)?.[1];
  expect((await fetch(`${url}${asset}`)).status).toBe(200);

  expect((await fetch(`${url}/missing`)).status).toBe(404);

  const client = new Client({ connectionString: database.url });
  await client.connect();
  const { rows } = await client.query("SELECT to_regclass('drizzle.__drizzle_migrations') AS t");
  await client.end();
  expect(rows[0].t).not.toBeNull();

  child.kill("SIGTERM");
  const [code, signal] = await once(child, "exit");
  expect({ code, signal }).toEqual({ code: 0, signal: null });
});
