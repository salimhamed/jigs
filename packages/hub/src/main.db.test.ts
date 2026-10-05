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

dbTest("serves the built hub, logs only real errors and exits on SIGTERM", async () => {
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
      HUB_GITHUB_CLIENT_ID: "client",
      HUB_GITHUB_CLIENT_SECRET: "secret",
      HUB_ADMIN_EMAIL: "admin@example.com",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
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

  const home = await fetch(`${url}/`, { redirect: "manual" });
  expect(home.status).toBe(302);
  expect(home.headers.get("location")).toBe("/sign-in");
  const signIn = await fetch(`${url}/sign-in`);
  expect(signIn.status).toBe(200);
  const html = await signIn.text();
  expect(html).toContain("Sign in with GitHub");
  const asset = /href="(\/assets\/[^"]+\.js)"/.exec(html)?.[1];
  expect((await fetch(`${url}${asset}`)).status).toBe(200);

  expect((await fetch(`${url}/missing`)).status).toBe(404);
  expect((await fetch(`${url}/api/auth/ok`)).status).toBe(200);

  const client = new Client({ connectionString: database.url });
  await client.connect();
  const { rows } = await client.query("SELECT to_regclass('drizzle.__drizzle_migrations') AS t");
  expect(rows[0].t).not.toBeNull();
  await client.query("ALTER TABLE invitation RENAME TO invitation_gone");
  await client.end();
  expect((await fetch(`${url}/invite/any`)).status).toBe(500);

  child.kill("SIGTERM");
  const [code, signal] = await once(child, "exit");
  expect({ code, signal }).toEqual({ code: 0, signal: null });
  expect(stderr).not.toContain("No route matches");
  expect(stderr.match(/relation "invitation" does not exist/g)).toHaveLength(1);
});
