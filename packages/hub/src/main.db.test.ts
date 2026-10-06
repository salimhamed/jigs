import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { messagesPath } from "@jigs-ai/hub-protocol";
import { Client } from "pg";
import { afterEach, expect } from "vitest";
import { connectDatabase } from "./db/database.ts";
import * as schema from "./db/schema.ts";
import { dbTest, testDatabase } from "./db/test-database.ts";
import { addFactory } from "./factories.ts";

const main = fileURLToPath(new URL("../dist/main.js", import.meta.url));
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function startHub() {
  const database = testDatabase();
  await database.create();
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
      HUB_SIGN_IN_GITHUB_CLIENT_ID: "client",
      HUB_SIGN_IN_GITHUB_CLIENT_SECRET: "secret",
      HUB_ADMIN_EMAIL: "admin@example.com",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
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
  return { database, child, url: url as string, stdout: () => stdout, stderr: () => stderr };
}

dbTest("serves the built hub, logs only real errors and exits on SIGTERM", async () => {
  const { database, child, url, stdout, stderr } = await startHub();

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

  const submitSignIn = (origin: string) =>
    fetch(`${url}/sign-in`, { method: "POST", headers: { origin }, redirect: "manual" });
  const fromHub = await submitSignIn("https://hub.example.com");
  expect(fromHub.status).toBe(302);
  expect(fromHub.headers.get("location")).toMatch(/^https:\/\/github\.com\/login\/oauth/);
  expect((await submitSignIn("https://elsewhere.example.com")).status).toBe(400);

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
  const [code, signal] = await once(child, "close");
  expect({ code, signal }).toEqual({ code: 0, signal: null });
  expect(stdout()).toContain("sign-in app Homepage URL: https://hub.example.com\n");
  expect(stdout()).toContain(
    "sign-in app Redirect URI: https://hub.example.com/api/auth/callback/github\n",
  );
  expect(stderr()).not.toContain("No route matches");
  expect(stderr()).toContain('relation "invitation" does not exist');
});

dbTest(
  "exits promptly on SIGTERM while a factory long-polls on a keep-alive connection",
  async () => {
    const { database, child, url, stderr } = await startHub();
    const db = connectDatabase(database.url);
    await db
      .insert(schema.organization)
      .values({ id: "acme", name: "Acme", slug: "acme", createdAt: new Date() });
    const { token } = await addFactory(db, "acme", "factory");
    await db.$client.end();

    // Polls again the moment an answer comes back, as eagerly as a factory could.
    let polling = true;
    let polls = 0;
    const poller = (async () => {
      while (polling) {
        polls += 1;
        try {
          const response = await fetch(`${url}${messagesPath}?wait=30`, {
            headers: { authorization: `Bearer ${token}` },
          });
          await response.text();
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }
    })();
    cleanups.push(async () => {
      polling = false;
      await poller;
    });
    while (polls === 0) await new Promise((resolve) => setTimeout(resolve, 10));
    await new Promise((resolve) => setTimeout(resolve, 200));

    const started = Date.now();
    child.kill("SIGTERM");
    const [code, signal] = await once(child, "close");
    expect({ code, signal }).toEqual({ code: 0, signal: null });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(stderr()).not.toContain("Failed query");
  },
  15_000,
);
