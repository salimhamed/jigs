import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { z } from "zod";
import { createApp } from "./app";
import type { Factory } from "./factory";

// The routes are exercised against pipelines this file declares: what is under
// test is the framework.
const fixture = {
  pipelines: {
    plain: {
      pipeline: async () => undefined,
      inputs: z.object({
        issueId: z.uuid(),
        askHuman: z.boolean().default(false),
      }),
    },
    dated: {
      pipeline: async () => undefined,
      inputs: z.object({ when: z.date(), name: z.string() }),
    },
  },
} satisfies Factory;

const app = createApp(fixture);

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
  // An ambient dev-database URL would otherwise make this lane open a real
  // connection and read the operator's registry.
  vi.stubEnv("WORKFLOW_POSTGRES_URL", "");
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

test("a signed check_suite delivery is routed to the PR it belongs to", async () => {
  const body = JSON.stringify({
    action: "completed",
    check_suite: {
      id: 9,
      conclusion: "failure",
      pull_requests: [{ number: 41 }],
    },
    repository: { name: "api", owner: { login: "acme" } },
  });
  const res = await postGithub(body, {
    "x-hub-signature-256": `sha256=${sign(body, "gh-hook-secret")}`,
    "x-github-event": "check_suite",
  });
  // Nobody is listening in this lane, so the delivery drops — what matters is
  // that it was routed at all rather than acknowledged as unroutable.
  expect(res.status).toBe(404);
  expect(await res.json()).toEqual({ delivered: false });
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

test("a validly signed non-JSON linear body is acknowledged and ignored", async () => {
  const body = "not json";
  const res = await postLinear(body, {
    "linear-signature": sign(body, "linear-hook-secret"),
  });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ignored: true });
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

test("cancel of a run nobody holds is a 404", async () => {
  const res = await app.request(
    "/api/runs/wrun_01ZZZZZZZZZZZZZZZZZZZZZZZZ/cancel",
    {
      method: "POST",
    },
  );
  expect(res.status).toBe(404);
  expect(await res.json()).toEqual({ error: "not found" });
});

test("a pipeline's inputs route answers with its JSON Schema", async () => {
  const res = await app.request("/api/pipelines/plain/inputs");
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    name: string;
    inputs: { properties: Record<string, unknown>; required: string[] };
  };
  expect(body.name).toBe("plain");
  expect(body.inputs.properties.issueId).toBeDefined();
  expect(body.inputs.required).toEqual(["issueId"]);
  // io: "input" — the defaulted field must not be demanded of the caller.
  expect(body.inputs.required).not.toContain("askHuman");
});

test("a member zod cannot render leaves the route green and the member open", async () => {
  const res = await app.request("/api/pipelines/dated/inputs");
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    inputs: { properties: Record<string, unknown> };
  };
  expect(body.inputs.properties.when).toEqual({});
  expect(body.inputs.properties.name).toEqual({ type: "string" });
});

test("an unknown pipeline's inputs route is a 404 naming the known pipelines", async () => {
  const res = await app.request("/api/pipelines/nope/inputs");
  expect(res.status).toBe(404);
  const body = (await res.json()) as {
    error: string;
    knownPipelines: string[];
  };
  expect(body.error).toBe("unknown pipeline: nope");
  expect(body.knownPipelines).toEqual(["plain", "dated"]);
});

test("health names the factory that answers here, and the injected pipelines", async () => {
  vi.stubEnv("JIGS_FACTORY_ROOT", "/factories/acme");
  const res = await app.request("/health");
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({
    ok: true,
    factoryRoot: "/factories/acme",
    pipelines: ["plain", "dated"],
  });
});

test("health outside a factory reports a null root rather than failing liveness", async () => {
  vi.stubEnv("JIGS_FACTORY_ROOT", "");
  const cwd = vi.spyOn(process, "cwd").mockReturnValue(dataDir);
  try {
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, factoryRoot: null });
  } finally {
    cwd.mockRestore();
  }
});

test("GET /api/runs answers with empty runs and worktrees when nothing has launched", async () => {
  vi.stubEnv("WORKFLOW_POSTGRES_URL", "");
  const res = await app.request("/api/runs");
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ runs: [], worktrees: [] });
});

test("POST /api/worktrees/sweep answers 503 when the worktree registry is unconfigured", async () => {
  const res = await app.request("/api/worktrees/sweep", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ clean: false, force: false }),
  });
  expect(res.status).toBe(503);
  expect(await res.json()).toEqual({
    error:
      "worktree registry unavailable: WORKFLOW_POSTGRES_URL is not configured",
  });
});
