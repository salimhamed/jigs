import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SPEC_VERSION_CURRENT } from "@workflow/world";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { resumeHook } from "workflow/api";
import { HookNotFoundError } from "workflow/errors";
import { setWorld } from "workflow/runtime";
import { z } from "zod";
import { resetGithubAuth } from "../providers/github-auth.ts";
import * as linear from "../providers/linear.ts";
import { resetLinearAuth } from "../providers/linear-auth.ts";
import * as sql from "../steps/runtime/registry.ts";
import { type Factory, ticketInputSchema } from "../workflow/factory.ts";
import { ticketToken } from "../workflow/linear/claim.ts";
import { needsHumanToken } from "../workflow/linear/halt-for-human.ts";
import { pullRequestToken } from "../workflow/pull-requests/pull-request.ts";
import * as queue from "./queue.ts";
import { clearWakes, lastWake } from "./wake-note.ts";

const ambientWorkflowEnv = vi.hoisted(() => {
  const targetWorld = process.env.WORKFLOW_TARGET_WORLD;
  const postgresUrl = process.env.WORKFLOW_POSTGRES_URL;
  delete process.env.WORKFLOW_TARGET_WORLD;
  delete process.env.WORKFLOW_POSTGRES_URL;
  return { targetWorld, postgresUrl };
});

vi.stubEnv("WORKFLOW_TARGET_WORLD", undefined);
vi.stubEnv("WORKFLOW_POSTGRES_URL", undefined);

const { createApp } = await import("./app.ts");

// The routes are exercised against workflows this file declares: what is under
// test is the framework.
const fixture = {
  workflows: {
    plain: {
      workflow: async () => undefined,
      inputs: z.object({
        ticket: ticketInputSchema,
        askHuman: z.boolean().default(false),
      }),
    },
    dated: {
      workflow: async () => undefined,
      inputs: z.object({ when: z.date(), name: z.string() }),
    },
  },
  webhooks: {
    url: "https://factory.example.ts.net",
    github: { enabled: true },
    linear: { enabled: true },
  },
} satisfies Factory;

const RUN = "wrun_01K3ANBZ4TQ8W9YV6H2E5C7DKM";

// The ingress hands every accepted delivery to the SDK's own resumeHook, and
// what a delivery is worth is what that call answers — so the SDK is what a
// test stands in for here, never a seam of the app's.
vi.mock("workflow/api", async (importActual) => ({
  ...(await importActual<typeof import("workflow/api")>()),
  resumeHook: vi.fn(),
}));
const resumeHookMock = vi.mocked(resumeHook);
// The ingress reads only whether the resume landed, never the hook it returns.
const delivers = () => resumeHookMock.mockResolvedValueOnce({} as never);

const app = createApp(fixture);

// A second factory, because what the schedule routes answer is a property of
// the config handed in. Nothing ticks here: the ticker is started by the
// generated nitro plugin, not by the app.
const scheduled = {
  workflows: fixture.workflows,
  schedules: {
    "nightly-plain": {
      workflow: "plain",
      cron: "0 3 * * *",
      inputs: { ticket: "AGE-317" },
    },
    "broken-cron": { workflow: "plain", cron: "always", inputs: {} },
  },
} satisfies Factory;
const scheduledApp = createApp(scheduled);

// The local world binds its data dir on first use, so one fresh dir serves
// the whole file; it starts empty — nobody holds any token here.
let dataDir: string;

beforeAll(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "jigs-app-test-"));
});
afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
  if (ambientWorkflowEnv.targetWorld === undefined) delete process.env.WORKFLOW_TARGET_WORLD;
  else process.env.WORKFLOW_TARGET_WORLD = ambientWorkflowEnv.targetWorld;
  if (ambientWorkflowEnv.postgresUrl === undefined) delete process.env.WORKFLOW_POSTGRES_URL;
  else process.env.WORKFLOW_POSTGRES_URL = ambientWorkflowEnv.postgresUrl;
});

beforeEach(() => {
  vi.unstubAllEnvs();
  // Every route that reads the registry gets an empty one rather than the
  // operator's database.
  vi.spyOn(sql, "registrySql").mockReturnValue({} as never);
  vi.spyOn(sql, "currentFactory").mockReturnValue("factory-test");
  vi.spyOn(sql, "listResources").mockResolvedValue([]);
  vi.spyOn(queue, "listJobRunIds").mockResolvedValue({ dead: [], live: [] });
  vi.spyOn(queue, "listRunDeadJobs").mockResolvedValue([]);
  vi.stubEnv("WORKFLOW_LOCAL_DATA_DIR", dataDir);
  vi.stubEnv("XDG_DATA_HOME", path.join(dataDir, "resources"));
  vi.stubEnv("WORKFLOW_TARGET_WORLD", undefined);
  vi.stubEnv("WORKFLOW_POSTGRES_URL", undefined);
  vi.stubEnv("GITHUB_WEBHOOK_SECRET", "gh-hook-secret");
  vi.stubEnv("GITHUB_TOKEN", "gh-service-token");
  vi.stubEnv("GITHUB_API_URL", "http://mock.test/github");
  vi.stubEnv("LINEAR_WEBHOOK_SECRET", "linear-hook-secret");
  resumeHookMock.mockReset().mockRejectedValue(new HookNotFoundError("unclaimed-test-token"));
  resetGithubAuth();
  resetLinearAuth();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  // Clears the cached world too, so the next getWorld() opens the local one
  // again from the data dir above.
  setWorld(undefined);
  resetGithubAuth();
  resetLinearAuth();
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
  });

test.each([
  ["no webhooks section", undefined],
  [
    "each provider switched off",
    {
      url: "https://factory.example.ts.net",
      github: { enabled: false },
      linear: { enabled: false },
    },
  ],
])("with %s, neither ingress route exists", async (_name, webhooks) => {
  const polling = createApp({ workflows: fixture.workflows, webhooks });
  const body = commentPayload();
  const github = await polling.request("/ingress/github", {
    method: "POST",
    body: reviewPayload,
    headers: { "x-hub-signature-256": `sha256=${sign(reviewPayload, "gh-hook-secret")}` },
  });
  const linearDelivery = await polling.request("/ingress/linear", {
    method: "POST",
    body,
    headers: { "linear-signature": sign(body, "linear-hook-secret") },
  });
  expect([github.status, linearDelivery.status]).toEqual([404, 404]);
  expect(resumeHookMock).not.toHaveBeenCalled();
});

test("one provider switched on mounts only its own route", async () => {
  const githubOnly = createApp({
    workflows: fixture.workflows,
    webhooks: { url: "https://f.test", github: { enabled: true }, linear: { enabled: false } },
  });
  const body = commentPayload();
  expect(
    (
      await githubOnly.request("/ingress/linear", {
        method: "POST",
        body,
        headers: { "linear-signature": sign(body, "linear-hook-secret") },
      })
    ).status,
  ).toBe(404);
  expect(
    (
      await githubOnly.request("/ingress/github", {
        method: "POST",
        body: reviewPayload,
        headers: { "x-github-event": "pull_request_review" },
      })
    ).status,
  ).toBe(401);
});

test("POST /ingress/github with a forged signature is a 401", async () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const res = await postGithub(reviewPayload, {
    "x-hub-signature-256": `sha256=${sign(reviewPayload, "wrong-secret")}`,
    "x-github-event": "pull_request_review",
  });
  expect(res.status).toBe(401);
  expect(log).toHaveBeenCalledExactlyOnceWith(
    "[ingress] github rejected reason=signature event=pull_request_review",
  );
});

test("POST /ingress/github without a signature header is a 401", async () => {
  const res = await postGithub(reviewPayload, {
    "x-github-event": "pull_request_review",
  });
  expect(res.status).toBe(401);
});

test("POST /ingress/github without a configured secret fails closed", async () => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.stubEnv("GITHUB_WEBHOOK_SECRET", "");
  const res = await postGithub(reviewPayload, {
    "x-hub-signature-256": `sha256=${sign(reviewPayload, "")}`,
  });
  expect(res.status).toBe(401);
  expect(resumeHookMock).not.toHaveBeenCalled();
});

test("a validly signed PR review delivery nobody is listening to is acknowledged", async () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const send = () =>
    postGithub(reviewPayload, {
      "x-hub-signature-256": `sha256=${sign(reviewPayload, "gh-hook-secret")}`,
      "x-github-event": "pull_request_review",
    });
  const res = await send();
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ delivered: false });
  expect(log).toHaveBeenLastCalledWith(
    "[ingress] github dropped reason=no-matching-hook token=github:pr:acme/api#41 event=pull_request_review",
  );
  // Nothing accumulated: the identical delivery drops the same way again.
  const again = await send();
  expect(again.status).toBe(200);
  expect(await again.json()).toEqual({ delivered: false });
  expect(log).toHaveBeenCalledTimes(2);
});

test("a GitHub delivery matching a hook logs acceptance with its token", async () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  delivers();
  const res = await postGithub(reviewPayload, {
    "x-hub-signature-256": `sha256=${sign(reviewPayload, "gh-hook-secret")}`,
    "x-github-event": "pull_request_review",
  });
  expect(res.status).toBe(200);
  expect(log).toHaveBeenCalledExactlyOnceWith(
    "[ingress] github accepted token=github:pr:acme/api#41 event=pull_request_review",
  );
});

test("a delivery in GitHub's canonical casing resumes a hook claimed from a lowercase remote", async () => {
  delivers();
  const body = JSON.stringify({
    action: "submitted",
    review: { id: 7, state: "approved" },
    pull_request: { number: 1 },
    repository: { name: "Data-Lake-Airflow", owner: { login: "Junglescout" } },
  });
  const res = await postGithub(body, {
    "x-hub-signature-256": `sha256=${sign(body, "gh-hook-secret")}`,
    "x-github-event": "pull_request_review",
  });
  expect(await res.json()).toEqual({ delivered: true });
  expect(resumeHookMock).toHaveBeenCalledExactlyOnceWith(
    "github:pr:junglescout/data-lake-airflow#1",
    undefined,
  );
});

test("a GitHub delivery failure is not misreported as a missing hook", async () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  resumeHookMock.mockRejectedValueOnce(new Error("database unavailable"));
  const res = await postGithub(reviewPayload, {
    "x-hub-signature-256": `sha256=${sign(reviewPayload, "gh-hook-secret")}`,
    "x-github-event": "pull_request_review",
  });
  expect(res.status).toBe(404);
  expect(await res.json()).toEqual({ delivered: false });
  expect(log).toHaveBeenCalledExactlyOnceWith(
    "[ingress] github dropped reason=delivery-failed token=github:pr:acme/api#41 event=pull_request_review",
  );
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
  // Nobody is listening in this lane, so the delivery is acknowledged and
  // dropped — what matters is that it was routed rather than ignored.
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ delivered: false });
});

const statusPayload = (state: string) =>
  JSON.stringify({
    sha: "status-sha",
    state,
    context: "AWS CodeBuild us-west-2",
    repository: { name: "fork", full_name: "contributor/fork", owner: { login: "contributor" } },
  });

const postStatus = (body: string) =>
  postGithub(body, {
    "x-hub-signature-256": `sha256=${sign(body, "gh-hook-secret")}`,
    "x-github-event": "status",
  });

test("a signed status delivery resolves every matching PR and routes by base repo", async () => {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify([
        {
          number: 41,
          state: "open",
          head: { sha: "status-sha" },
          base: { repo: { name: "api", owner: { login: "acme" } } },
        },
        {
          number: 7,
          state: "open",
          head: { sha: "status-sha" },
          base: { repo: { name: "web", owner: { login: "acme" } } },
        },
      ]),
    ),
  );
  vi.stubGlobal("fetch", fetchMock);
  resumeHookMock
    .mockResolvedValueOnce({} as never)
    .mockRejectedValueOnce(new HookNotFoundError("unclaimed"));

  const res = await postStatus(statusPayload("failure"));

  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ delivered: true });
  expect(resumeHookMock.mock.calls.map(([token]) => token).sort()).toEqual(
    [
      pullRequestToken({ owner: "acme", repo: "api", number: 41 }),
      pullRequestToken({ owner: "acme", repo: "web", number: 7 }),
    ].sort(),
  );
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test("pending status is ignored without a sha lookup", async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

  const res = await postStatus(statusPayload("pending"));

  expect(res.status).toBe(200);
  expect(fetchMock).not.toHaveBeenCalled();
  expect(resumeHookMock).not.toHaveBeenCalled();
  expect(log).toHaveBeenCalledWith("[ingress] github ignored reason=pending-status event=status");
});

test("status with no open PR is dropped without waking a gate", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("[]")));
  const res = await postStatus(statusPayload("success"));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ delivered: false });
  expect(resumeHookMock).not.toHaveBeenCalled();
});

test("a status lookup failure is acknowledged as unroutable rather than a 500", async () => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const res = await postStatus(statusPayload("failure"));
  expect(res.status).toBe(404);
  expect(await res.json()).toEqual({ delivered: false });
  expect(log).toHaveBeenCalledWith(
    "[ingress] github dropped reason=status-lookup-failed event=status",
  );
});

test("an unroutable github event is acknowledged and ignored", async () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
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
  expect(log).toHaveBeenCalledExactlyOnceWith(
    "[ingress] github ignored reason=unrecognized-event event=ping",
  );
});

test("POST /ingress/linear with a forged signature is a 401", async () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const body = commentPayload();
  const res = await postLinear(body, {
    "linear-signature": sign(body, "wrong-secret"),
  });
  expect(res.status).toBe(401);
  expect(log).toHaveBeenCalledExactlyOnceWith("[ingress] linear rejected reason=signature");
});

test("a validly signed Comment delivery for an unclaimed issue is acknowledged", async () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const body = commentPayload();
  const issueId = (JSON.parse(body) as { data: { issueId: string } }).data.issueId;
  const res = await postLinear(body, {
    "linear-signature": sign(body, "linear-hook-secret"),
  });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ delivered: false });
  expect(log).toHaveBeenCalledExactlyOnceWith(
    `[ingress] linear dropped reason=no-matching-hook token=linear:ticket:${issueId} event=Comment`,
  );
});

test("a Linear delivery matching a hook logs acceptance with its token", async () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  delivers();
  const body = commentPayload();
  const issueId = (JSON.parse(body) as { data: { issueId: string } }).data.issueId;
  const res = await postLinear(body, {
    "linear-signature": sign(body, "linear-hook-secret"),
  });
  expect(res.status).toBe(200);
  expect(log).toHaveBeenCalledExactlyOnceWith(
    `[ingress] linear accepted token=linear:ticket:${issueId} event=Comment`,
  );
});

test("a validly signed non-JSON linear body is acknowledged and ignored", async () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const body = "not json";
  const res = await postLinear(body, {
    "linear-signature": sign(body, "linear-hook-secret"),
  });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ignored: true });
  expect(log).toHaveBeenCalledExactlyOnceWith("[ingress] linear ignored reason=unrecognized-shape");
});

test("an unroutable linear resource type is acknowledged and ignored", async () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const body = JSON.stringify({
    action: "update",
    type: "Issue",
    data: { id: "issue-1" },
  });
  const res = await postLinear(body, {
    "linear-signature": sign(body, "linear-hook-secret"),
  });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ignored: true });
  expect(log).toHaveBeenCalledExactlyOnceWith(
    "[ingress] linear ignored reason=unrecognized-event event=Issue",
  );
});

test("poke of an unknown run is a 404", async () => {
  const res = await app.request("/api/runs/wr_does_not_exist/poke", {
    method: "POST",
  });
  expect(res.status).toBe(404);
});

test("cancel of a run nobody holds is a 404", async () => {
  const res = await app.request("/api/runs/wrun_01ZZZZZZZZZZZZZZZZZZZZZZZZ/cancel", {
    method: "POST",
  });
  expect(res.status).toBe(404);
  expect(await res.json()).toEqual({ error: "not found" });
});

test.each([
  ["a prefix", RUN.slice(0, 13)],
  ["a bare prefix", RUN.slice(5, 13)],
  ["a ticket", "AGE-317"],
])("a run route answers 404 for %s, even when a run matches it", async (_label, ref) => {
  const lookups: string[] = [];
  setWorld({
    specVersion: SPEC_VERSION_CURRENT,
    runs: {
      get: async (runId: string) => {
        lookups.push(runId);
        return { runId: RUN, status: "running", createdAt: new Date() };
      },
      list: async () => ({ data: [{ runId: RUN }], hasMore: false, cursor: null }),
    },
    hooks: { list: async () => ({ data: [] }) },
  } as unknown as Parameters<typeof setWorld>[0]);

  const res = await app.request(`/api/runs/${ref}`);

  expect(res.status).toBe(404);
  expect(await res.json()).toEqual({ error: "not found" });
  expect(lookups).toEqual([]);
});

test("a workflow's inputs route answers with its JSON Schema", async () => {
  const res = await app.request("/api/workflows/plain/inputs");
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    name: string;
    inputs: { properties: Record<string, unknown>; required: string[] };
  };
  expect(body.name).toBe("plain");
  expect(body.inputs.properties.ticket).toBeDefined();
  expect(body.inputs.required).toEqual(["ticket"]);
  // io: "input" — the defaulted field must not be demanded of the caller.
  expect(body.inputs.required).not.toContain("askHuman");
});

test("a member zod cannot render leaves the route green and the member open", async () => {
  const res = await app.request("/api/workflows/dated/inputs");
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    inputs: { properties: Record<string, unknown> };
  };
  expect(body.inputs.properties.when).toEqual({});
  expect(body.inputs.properties.name).toEqual({ type: "string" });
});

test("an unknown workflow's inputs route is a 404 naming the known workflows", async () => {
  const res = await app.request("/api/workflows/nope/inputs");
  expect(res.status).toBe(404);
  const body = (await res.json()) as {
    error: string;
    knownWorkflows: string[];
  };
  expect(body.error).toBe("unknown workflow: nope");
  expect(body.knownWorkflows).toEqual(["plain", "dated"]);
});

test("workflow discovery returns actual launch names and their existing input metadata", async () => {
  const res = await app.request("/api/workflows");
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    workflows: Array<{ name: string; inputs: { properties: Record<string, unknown> } }>;
  };
  expect(body.workflows.map((workflow) => workflow.name)).toEqual(["plain", "dated"]);
  expect(body.workflows[0]?.inputs.properties.ticket).toBeDefined();
  expect(body.workflows[0]?.inputs.properties.askHuman).toMatchObject({
    type: "boolean",
    default: false,
  });
});

test("health names the factory that answers here, and the injected workflows", async () => {
  vi.stubEnv("JIGS_FACTORY_ROOT", "/factories/acme");
  const res = await app.request("/health");
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({
    ok: true,
    // No start-world plugin has run here, so the boot has not begun: live,
    // but not what `jigs service start` waits for.
    ready: false,
    phase: "starting",
    factoryRoot: "/factories/acme",
    workflows: ["plain", "dated"],
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

test("GET /api/runs answers with empty runs when nothing has launched", async () => {
  const res = await app.request("/api/runs");
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ runs: [], schedules: [] });
});

test("GET /api/runs lists each run with the resources it recorded and their states", async () => {
  const at = new Date("2026-09-04T10:00:00.000Z");
  const row = (kind: string, state: "kept" | "released", reason: string) => ({
    factory: "factory-test",
    runId: RUN,
    kind,
    identity: `${kind}-1`,
    url: `https://example.test/${kind}`,
    state,
    reason,
    attempts: 0,
    repoDir: null,
    branch: null,
    createdAt: at,
    updatedAt: at,
  });
  vi.spyOn(sql, "listResources").mockResolvedValue([
    row("worktree", "kept", "uncommitted work kept"),
    row("pull-request", "released", "recorded only"),
  ]);
  setWorld({
    specVersion: SPEC_VERSION_CURRENT,
    runs: {
      list: async () => ({
        data: [
          { runId: RUN, status: "failed", workflowName: "wf", createdAt: at, completedAt: at },
        ],
        hasMore: false,
      }),
    },
    hooks: { list: async () => ({ data: [], hasMore: false }) },
    steps: { list: async () => ({ data: [], hasMore: false }) },
  } as unknown as Parameters<typeof setWorld>[0]);

  const body = (await (await app.request("/api/runs")).json()) as {
    runs: Array<{ runId: string; status: string; resources: unknown[] }>;
  };

  expect(body.runs).toMatchObject([
    {
      runId: RUN,
      status: "failed",
      resources: [
        { kind: "worktree", state: "kept", reason: "uncommitted work kept" },
        { kind: "pull-request", state: "released", reason: "recorded only" },
      ],
    },
  ]);
});

test("GET /api/runs/:runId/steps answers with the run's steps and its dead jobs", async () => {
  setWorld({
    specVersion: SPEC_VERSION_CURRENT,
    runs: { get: async () => ({}) },
    steps: {
      list: async () => ({
        data: [
          {
            stepName: "step//./steps/jigs//worktree",
            status: "failed",
            attempt: 3,
            createdAt: new Date("2026-09-04T10:00:00.000Z"),
            startedAt: new Date("2026-09-04T10:00:00.000Z"),
            completedAt: new Date("2026-09-04T10:00:04.000Z"),
            error: { message: "worktree is held by another run" },
          },
        ],
      }),
    },
  } as unknown as Parameters<typeof setWorld>[0]);

  const res = await app.request(`/api/runs/${RUN}/steps`);

  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    steps: [
      {
        name: "step//./steps/jigs//worktree",
        status: "failed",
        attempt: 3,
        startedAt: "2026-09-04T10:00:00.000Z",
        completedAt: "2026-09-04T10:00:04.000Z",
        error: "worktree is held by another run",
      },
    ],
    deadJobs: [],
  });
});

test("a steps request for a run nobody launched is a 404", async () => {
  const res = await app.request(`/api/runs/${RUN}/steps`);
  expect(res.status).toBe(404);
});

test("GET /api/runs/:runId reports a stalled run as stalled, like `jigs status` does", async () => {
  // Status list and detail must not disagree about the same run, so both
  // read the one derivation in runs.ts.
  setWorld({
    specVersion: SPEC_VERSION_CURRENT,
    runs: { get: async () => ({ status: "running", createdAt: new Date() }) },
    steps: { list: async () => ({ data: [] }) },
    hooks: { list: async () => ({ data: [] }) },
  } as unknown as Parameters<typeof setWorld>[0]);
  vi.spyOn(queue, "listJobRunIds").mockResolvedValue({
    dead: [RUN],
    live: [],
  });

  const res = await app.request(`/api/runs/${RUN}`);

  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({
    runId: RUN,
    status: "stalled",
  });
});

test("GET /api/runs/:runId reports the run's resources and claim from its state read", async () => {
  const row = {
    factory: "factory-test",
    runId: RUN,
    kind: "pull-request",
    identity: "acme/api#41",
    url: "https://github.com/acme/api/pull/41",
    state: "live" as const,
    reason: null,
    attempts: 0,
    repoDir: null,
    branch: null,
    createdAt: new Date("2026-09-04T10:00:00.000Z"),
    updatedAt: new Date("2026-09-04T10:00:00.000Z"),
  };
  const listed = vi.spyOn(sql, "listResources").mockResolvedValue([row]);
  const claim = ticketToken("68bc9696-35d5-442d-ab56-214c8cfefbec");
  setWorld({
    specVersion: SPEC_VERSION_CURRENT,
    runs: {
      get: async () => ({
        runId: RUN,
        status: "running",
        workflowName: "wf",
        createdAt: new Date(),
      }),
    },
    steps: { list: async () => ({ data: [] }) },
    hooks: { list: async () => ({ data: [{ runId: RUN, token: claim }] }) },
  } as unknown as Parameters<typeof setWorld>[0]);

  const res = await app.request(`/api/runs/${RUN}`);
  const body = (await res.json()) as { resources: unknown; claim: unknown };

  expect(res.status).toBe(200);
  expect(listed).toHaveBeenCalledWith({}, { factory: "factory-test", runId: RUN });
  expect(body.claim).toBe(claim);
  expect(body.resources).toEqual([
    {
      runId: RUN,
      kind: "pull-request",
      identity: "acme/api#41",
      url: "https://github.com/acme/api/pull/41",
      state: "live",
      reason: null,
      updatedAt: "2026-09-04T10:00:00.000Z",
    },
  ]);
});

const CLAIM = ticketToken("68bc9696-35d5-442d-ab56-214c8cfefbec");
const MARKER = needsHumanToken("68bc9696-35d5-442d-ab56-214c8cfefbec", "c1");
const PR = pullRequestToken({ owner: "acme", repo: "api", number: 41 });

// A running run holding exactly these hooks. The routes below read no other
// world surface, so anything they touch beyond `hooks.list` rejects and is
// reported rather than thrown.
const runHolding = (...tokens: string[]) =>
  (() => {
    let status = "running";
    let held = [...tokens];
    return setWorld({
      specVersion: SPEC_VERSION_CURRENT,
      runs: { get: async () => ({ status, createdAt: new Date() }) },
      steps: { list: async () => ({ data: [] }) },
      hooks: { list: async () => ({ data: held.map((token) => ({ token })) }) },
      events: {
        create: async () => {
          status = "cancelled";
          held = [];
        },
      },
    } as unknown as Parameters<typeof setWorld>[0]);
  })();

test("GET /api/runs/:runId says what each park is waiting for, and where to act", async () => {
  runHolding(CLAIM, MARKER, PR);
  // The halt's comment is read back from Linear; a Linear nobody can ask
  // leaves the suspension as the token alone describes it.
  vi.spyOn(linear, "getComment").mockResolvedValue({
    url: "https://linear.app/acme/issue/AGE-317#comment-c1",
    body: "Which binding?",
  });

  const res = await app.request(`/api/runs/${RUN}`);

  expect(res.status).toBe(200);
  // The claim is held for the run's whole life, so it is no suspension and
  // never appears; the other two explain themselves without a metadata read.
  expect(await res.json()).toMatchObject({
    status: "suspended",
    suspensions: [
      {
        token: MARKER,
        kind: "needs-human",
        reason: "waiting for a human reply on 68bc9696-35d5-442d-ab56-214c8cfefbec",
        url: "https://linear.app/acme/issue/AGE-317#comment-c1",
        question: "Which binding?",
      },
      {
        token: PR,
        kind: "pull-request",
        reason: "waiting for pull request activity on acme/api#41",
        url: "https://github.com/acme/api/pull/41",
      },
    ],
  });
});

test("a halt whose comment Linear will not hand back keeps the park it can state", async () => {
  runHolding(CLAIM, MARKER);
  vi.spyOn(linear, "getComment").mockRejectedValue(new Error("Linear API key is not set"));

  const res = await app.request(`/api/runs/${RUN}`);

  expect(res.status).toBe(200);
  const body = (await res.json()) as { suspensions: Array<Record<string, unknown>> };
  expect(body.suspensions).toEqual([
    {
      token: MARKER,
      kind: "needs-human",
      reason: "waiting for a human reply on 68bc9696-35d5-442d-ab56-214c8cfefbec",
    },
  ]);
});

test("a run holding only its ticket claim is running, not suspended", async () => {
  runHolding(CLAIM);

  const res = await app.request(`/api/runs/${RUN}`);

  expect(await res.json()).toMatchObject({
    status: "running",
    suspensions: [],
    trigger: "manual",
  });
});

test("poke wakes the hooks that name a resource, never the needs-human marker", async () => {
  runHolding(CLAIM, MARKER);

  const res = await app.request(`/api/runs/${RUN}/poke`, { method: "POST" });

  expect(res.status).toBe(200);
  // The reply that ends a needs-human halt lands on the ticket claim, so the
  // marker names no channel and resuming it would wake nothing.
  expect(await res.json()).toMatchObject({ poked: [{ token: CLAIM }] });
});

test("a poke that landed is the wake the run's status reports", async () => {
  clearWakes();
  runHolding(CLAIM);
  delivers();

  await app.request(`/api/runs/${RUN}/poke`, { method: "POST" });

  expect(lastWake(CLAIM, RUN)?.kind).toBe("poke");
});

test("cancel reports observed hook release, retained worktrees, and no queue-deletion count", async () => {
  runHolding(CLAIM, MARKER);

  const res = await app.request(`/api/runs/${RUN}/cancel`, { method: "POST" });

  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    runId: RUN,
    cancelled: true,
    releasedTokens: [CLAIM],
    retainedTokens: [],
    worktrees: [],
  });
});

test("cancel reports a hook the World retains", async () => {
  setWorld({
    specVersion: SPEC_VERSION_CURRENT,
    runs: { get: async () => ({ status: "running", createdAt: new Date() }) },
    hooks: { list: async () => ({ data: [{ token: CLAIM }] }) },
    events: { create: async () => undefined },
  } as unknown as Parameters<typeof setWorld>[0]);

  const res = await app.request(`/api/runs/${RUN}/cancel`, { method: "POST" });

  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ releasedTokens: [], retainedTokens: [CLAIM] });
});

test("GET /api/schedules answers with what the factory declared, and what is next", async () => {
  const res = await scheduledApp.request("/api/schedules");
  expect(res.status).toBe(200);
  const body = (await res.json()) as Array<{
    name: string;
    workflow: string;
    cron: string;
    next: string | null;
    active: string | null;
  }>;
  expect(body.map((s) => s.name)).toEqual(["nightly-plain", "broken-cron"]);
  expect(body[0]).toMatchObject({
    name: "nightly-plain",
    workflow: "plain",
    cron: "0 3 * * *",
    active: null,
  });
  expect(new Date(body[0]?.next ?? "").getTime()).toBeGreaterThan(Date.now());
  // Declared but unschedulable: it is still reported, with nothing to come.
  expect(body[1]).toMatchObject({ name: "broken-cron", next: null });
});

test("a factory with no schedules answers an empty listing", async () => {
  const res = await app.request("/api/schedules");
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual([]);
});
