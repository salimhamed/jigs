import { createHmac } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import {
  githubWebhookSecret,
  verifyGithubSignature,
  verifyLinearSignature,
} from "./ingress.ts";

afterEach(() => {
  vi.unstubAllEnvs();
});

const hmac = (body: string, secret: string) =>
  createHmac("sha256", secret).update(body).digest("hex");

test("github signature verifies against the raw body", () => {
  const body = JSON.stringify({ action: "submitted" });
  const header = `sha256=${hmac(body, "s3cret")}`;
  expect(verifyGithubSignature(body, header, "s3cret")).toBe(true);
});

test("github signature rejects a tampered body", () => {
  const header = `sha256=${hmac('{"action":"submitted"}', "s3cret")}`;
  expect(verifyGithubSignature('{"action":"approved"}', header, "s3cret")).toBe(
    false,
  );
});

test("github signature rejects the wrong secret", () => {
  const body = "{}";
  const header = `sha256=${hmac(body, "other")}`;
  expect(verifyGithubSignature(body, header, "s3cret")).toBe(false);
});

test("github signature rejects a malformed or missing header", () => {
  const body = "{}";
  expect(verifyGithubSignature(body, undefined, "s3cret")).toBe(false);
  expect(verifyGithubSignature(body, hmac(body, "s3cret"), "s3cret")).toBe(
    false,
  );
  expect(verifyGithubSignature(body, "sha256=", "s3cret")).toBe(false);
  expect(verifyGithubSignature(body, "sha256=abc123", "s3cret")).toBe(false);
  expect(
    verifyGithubSignature(body, `sha256=${"zz".repeat(32)}`, "s3cret"),
  ).toBe(false);
});

test("linear signature verifies and rejects the wrong secret", () => {
  const body = JSON.stringify({ type: "Comment" });
  expect(
    verifyLinearSignature(body, hmac(body, "lin-secret"), "lin-secret"),
  ).toBe(true);
  expect(verifyLinearSignature(body, hmac(body, "wrong"), "lin-secret")).toBe(
    false,
  );
  expect(verifyLinearSignature(body, undefined, "lin-secret")).toBe(false);
});

test("github secret resolver prefers env and falls back to the data-dir file", () => {
  const dataHome = mkdtempSync(path.join(tmpdir(), "jigs-ingress-test-"));
  try {
    vi.stubEnv("XDG_DATA_HOME", dataHome);
    vi.stubEnv("GITHUB_WEBHOOK_SECRET", "");
    expect(githubWebhookSecret()).toBe(null);

    mkdirSync(path.join(dataHome, "jigs"), { recursive: true });
    writeFileSync(
      path.join(dataHome, "jigs", "github-webhook-secret"),
      "file-secret\n",
    );
    expect(githubWebhookSecret()).toBe("file-secret");

    vi.stubEnv("GITHUB_WEBHOOK_SECRET", "env-secret");
    expect(githubWebhookSecret()).toBe("env-secret");
  } finally {
    rmSync(dataHome, { recursive: true, force: true });
  }
});
