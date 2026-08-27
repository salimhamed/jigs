import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import app from "./app";

// The local world binds its data dir on first use, so one fresh dir serves
// the whole file; it starts empty — nobody holds any token here.
let dataDir: string;

beforeAll(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "jigs-app-test-"));
});
afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("WORKFLOW_LOCAL_DATA_DIR", dataDir);
  vi.stubEnv("GITHUB_WEBHOOK_SECRET", "gh-hook-secret");
  vi.stubEnv("LINEAR_WEBHOOK_SECRET", "linear-hook-secret");
});

const sign = (body: string, secret: string) =>
  createHmac("sha256", secret).update(body).digest("hex");

const postGithub = (body: string, headers: Record<string, string>) =>
  app.request("/ingress/github", { method: "POST", body, headers });

const postLinear = (body: string, headers: Record<string, string>) =>
  app.request("/ingress/linear", { method: "POST", body, headers });

const reviewPayload = JSON.stringify({
  action: "submitted",
  review: { id: 7, state: "approved" },
  pull_request: { number: 41 },
  repository: { name: "api", owner: { login: "acme" } },
});

const commentPayload = () =>
  JSON.stringify({
    action: "create",
    type: "Comment",
    data: { id: "c1", body: "reply", issueId: crypto.randomUUID() },
    webhookTimestamp: Date.now(),
  });

test("POST /ingress/github with a forged signature is a 401", async () => {
  const res = await postGithub(reviewPayload, {
    "x-hub-signature-256": `sha256=${sign(reviewPayload, "wrong-secret")}`,
    "x-github-event": "pull_request_review",
  });
  expect(res.status).toBe(401);
});

test("POST /ingress/github without a signature header is a 401", async () => {
  const res = await postGithub(reviewPayload, {
    "x-github-event": "pull_request_review",
  });
  expect(res.status).toBe(401);
});

test("POST /ingress/github without a configured secret is a 503", async () => {
  vi.stubEnv("GITHUB_WEBHOOK_SECRET", "");
  vi.stubEnv("XDG_DATA_HOME", dataDir);
  const res = await postGithub(reviewPayload, {
    "x-hub-signature-256": `sha256=${sign(reviewPayload, "gh-hook-secret")}`,
  });
  expect(res.status).toBe(503);
});

test("a validly signed PR review delivery nobody is listening to is dropped with a 404", async () => {
  const send = () =>
    postGithub(reviewPayload, {
      "x-hub-signature-256": `sha256=${sign(reviewPayload, "gh-hook-secret")}`,
      "x-github-event": "pull_request_review",
    });
  const res = await send();
  expect(res.status).toBe(404);
  expect(await res.json()).toEqual({ delivered: false });
  // Nothing accumulated: the identical delivery drops the same way again.
  const again = await send();
  expect(again.status).toBe(404);
  expect(await again.json()).toEqual({ delivered: false });
});

test("an unroutable github event is acknowledged and ignored", async () => {
  const ping = JSON.stringify({
    zen: "Keep it logically awesome.",
    hook_id: 1,
    repository: { name: "api", owner: { login: "acme" } },
  });
  const res = await postGithub(ping, {
    "x-hub-signature-256": `sha256=${sign(ping, "gh-hook-secret")}`,
    "x-github-event": "ping",
  });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ignored: true });
});

test("POST /ingress/linear with a forged signature is a 401", async () => {
  const body = commentPayload();
  const res = await postLinear(body, {
    "linear-signature": sign(body, "wrong-secret"),
  });
  expect(res.status).toBe(401);
});

test("POST /ingress/linear with a valid signature but a stale webhookTimestamp is a 401 (replay)", async () => {
  const body = JSON.stringify({
    action: "create",
    type: "Comment",
    data: { id: "c1", body: "reply", issueId: crypto.randomUUID() },
    webhookTimestamp: Date.now() - 5 * 60_000,
  });
  const res = await postLinear(body, {
    "linear-signature": sign(body, "linear-hook-secret"),
  });
  expect(res.status).toBe(401);
  expect(await res.json()).toEqual({ error: "stale webhookTimestamp" });
});

test("a validly signed Comment delivery for an unclaimed issue is dropped with a 404", async () => {
  const body = commentPayload();
  const res = await postLinear(body, {
    "linear-signature": sign(body, "linear-hook-secret"),
  });
  expect(res.status).toBe(404);
  expect(await res.json()).toEqual({ delivered: false });
});

test("an unroutable linear resource type is acknowledged and ignored", async () => {
  const body = JSON.stringify({
    action: "update",
    type: "Issue",
    data: { id: "issue-1" },
    webhookTimestamp: Date.now(),
  });
  const res = await postLinear(body, {
    "linear-signature": sign(body, "linear-hook-secret"),
  });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ignored: true });
});

test("poke of an unknown run is a 404", async () => {
  const res = await app.request("/api/runs/wr_does_not_exist/poke", {
    method: "POST",
  });
  expect(res.status).toBe(404);
});
