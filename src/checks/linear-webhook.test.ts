import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type { LinearWebhook } from "../providers/linear.ts";
import { linearWebhookChecks } from "./linear-webhook.ts";

const roots: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function factoryWith(webhooks: unknown): string {
  const root = mkdtempSync(path.join(tmpdir(), "jigs-linear-webhook-"));
  roots.push(root);
  writeFileSync(
    path.join(root, "jigs.config.ts"),
    `export default ${JSON.stringify({ service: { dashboardPort: 8991 }, workflows: {}, ...(webhooks === null ? {} : { webhooks }) })};`,
  );
  return root;
}

const enabled = (url = "https://factory.example.test", linear = true) => ({
  url,
  github: { enabled: false },
  linear: { enabled: linear },
});

function checks(webhooks: LinearWebhook[], config: unknown = enabled()) {
  vi.stubEnv("LINEAR_WEBHOOK_SECRET", "linear-secret");
  const root = factoryWith(config);
  return linearWebhookChecks({
    factoryRoot: () => root,
    list: vi.fn(async () => webhooks),
  });
}

const webhookCheck = (list: ReturnType<typeof checks>) =>
  list.find((check) => check.id === "linear.webhook");

const run = async (webhooks: LinearWebhook[]) => webhookCheck(checks(webhooks))?.run();

test("an enabled webhook at the exact ingress URL passes", async () => {
  await expect(
    run([{ url: "https://factory.example.test/ingress/linear", enabled: true }]),
  ).resolves.toEqual({ ok: true });
});

test("all trailing slashes are removed from webhooks.url", async () => {
  const result = await webhookCheck(
    checks(
      [{ url: "https://factory.example.test/ingress/linear", enabled: true }],
      enabled("https://factory.example.test///"),
    ),
  )?.run();
  expect(result).toEqual({ ok: true });
});

test("a disabled webhook fails and names its URL in the repair", async () => {
  const result = await run([
    { url: "https://factory.example.test/ingress/linear", enabled: false },
  ]);
  expect(result).toMatchObject({
    ok: false,
    repair: expect.stringContaining("https://factory.example.test/ingress/linear"),
  });
});

test("a missing webhook says to create a Comment webhook", async () => {
  const result = await run([]);
  expect(result).toMatchObject({
    ok: false,
    repair: expect.stringMatching(/create .*resource type Comment/),
  });
});

test("another host is not a match and is named as possible stale state", async () => {
  const result = await run([{ url: "https://old.example.test/ingress/linear", enabled: true }]);
  expect(result).toMatchObject({
    ok: false,
    repair: expect.stringContaining("old.example.test"),
  });
});

test("an API refusal fails with an admin-key repair", async () => {
  const root = factoryWith(enabled());
  const refusal = webhookCheck(
    linearWebhookChecks({
      factoryRoot: () => root,
      list: async () => {
        throw new Error("forbidden");
      },
    }),
  );
  await expect(refusal?.run()).resolves.toMatchObject({
    ok: false,
    repair: expect.stringContaining("admin API key"),
  });
});

test.each([
  ["no webhooks block", null],
  ["Linear switched off", enabled("https://factory.example.test", false)],
])("%s emits no Linear webhook checks", (_name, config) => {
  expect(checks([], config)).toEqual([]);
});

test("Linear switched on without its secret fails and names the variable", async () => {
  const list = checks([{ url: "https://factory.example.test/ingress/linear", enabled: true }]);
  vi.stubEnv("LINEAR_WEBHOOK_SECRET", "");
  const secret = list.find((check) => check.id === "linear.webhook-secret");
  await expect(secret?.run()).resolves.toMatchObject({
    ok: false,
    reason: expect.stringContaining("LINEAR_WEBHOOK_SECRET is not set"),
  });
});
