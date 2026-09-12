import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type { LinearWebhook } from "../providers/linear.ts";
import { linearWebhookChecks } from "./linear-webhook.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function checks(webhooks: LinearWebhook[], ingressUrl = "https://factory.example.test") {
  const root = mkdtempSync(path.join(tmpdir(), "jigs-linear-webhook-"));
  roots.push(root);
  writeFileSync(
    path.join(root, "jigs.config.ts"),
    `export default ${JSON.stringify({ service: { dashboardPort: 8991 }, workflows: {}, ...(ingressUrl === "" ? {} : { ingressUrl }) })};`,
  );
  return linearWebhookChecks({
    factoryRoot: () => root,
    list: vi.fn(async () => webhooks),
  });
}

const run = async (webhooks: LinearWebhook[]) => checks(webhooks)[0]?.run();

test("an enabled webhook at the exact ingress URL passes", async () => {
  await expect(
    run([{ url: "https://factory.example.test/ingress/linear", enabled: true }]),
  ).resolves.toEqual({ ok: true });
});

test("all trailing slashes are removed from ingressUrl", async () => {
  const result = await checks(
    [{ url: "https://factory.example.test/ingress/linear", enabled: true }],
    "https://factory.example.test///",
  )[0]?.run();
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
  const refusal = linearWebhookChecks({
    factoryRoot: () => {
      const root = mkdtempSync(path.join(tmpdir(), "jigs-linear-webhook-"));
      roots.push(root);
      writeFileSync(
        path.join(root, "jigs.config.ts"),
        'export default { service: { dashboardPort: 8991 }, workflows: {}, ingressUrl: "https://factory.example.test" };',
      );
      return root;
    },
    list: async () => {
      throw new Error("forbidden");
    },
  })[0];
  await expect(refusal?.run()).resolves.toMatchObject({
    ok: false,
    repair: expect.stringContaining("admin API key"),
  });
});

test("no ingressUrl emits no Linear webhook check", () => {
  expect(checks([], "")).toEqual([]);
});
