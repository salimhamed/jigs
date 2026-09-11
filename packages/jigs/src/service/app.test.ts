import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
  vi,
} from "vitest";
import { resumeHook } from "workflow/api";
import { HookNotFoundError } from "workflow/errors";
import { setWorld } from "workflow/runtime";
import { z } from "zod";
import { type Factory, ticketInput } from "../blocks/factory.ts";
import { prToken } from "../blocks/pull-request/gate.ts";
import { ticketToken } from "../blocks/ticket/claim.ts";
import { needsHumanToken } from "../blocks/ticket/halt-for-human.ts";
import * as sql from "../steps/worktree/sql.ts";
import { makeFakeSql } from "../steps/worktree/test-fixtures.ts";
import { createApp } from "./app.ts";
import * as stalls from "./stalls.ts";

// The routes are exercised against pipelines this file declares: what is under
// test is the framework.
const fixture = {
  pipelines: {
    plain: {
      pipeline: async () => undefined,
      inputs: z.object({
        ticket: ticketInput,
        askHuman: z.boolean().default(false),
      }),
    },
    dated: {
      pipeline: async () => undefined,
      inputs: z.object({ when: z.date(), name: z.string() }),
    },
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
  pipelines: fixture.pipelines,
  schedules: {
    "nightly-plain": {
      pipeline: "plain",
      cron: "0 3 * * *",
      inputs: { ticket: "AGE-317" },
    },
    "broken-cron": { pipeline: "plain", cron: "always", inputs: {} },
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
});

beforeEach(() => {
  vi.unstubAllEnvs();
  // The registry is a hard dependency now, so every route that reads it is
  // pointed at an empty in-memory one rather than the operator's database.
  vi.spyOn(sql, "registrySql").mockReturnValue(makeFakeSql(new Map()));
  vi.spyOn(stalls, "listJobRunIds").mockResolvedValue({ dead: [], live: [] });
  vi.spyOn(stalls, "listRunDeadJobs").mockResolvedValue([]);
  vi.stubEnv("WORKFLOW_LOCAL_DATA_DIR", dataDir);
  vi.stubEnv("GITHUB_WEBHOOK_SECRET", "gh-hook-secret");
  vi.stubEnv("LINEAR_WEBHOOK_SECRET", "linear-hook-secret");
  resumeHookMock
    .mockReset()
    .mockRejectedValue(new HookNotFoundError("unclaimed-test-token"));
});
afterEach(() => {
  vi.restoreAllMocks();
  // Clears the cached world too, so the next getWorld() opens the local one
  // again from the data dir above.
  setWorld(undefined);
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

test("POST /ingress/github without a configured secret is a 503", async () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.stubEnv("GITHUB_WEBHOOK_SECRET", "");
  vi.stubEnv("XDG_DATA_HOME", dataDir);
  const res = await postGithub(reviewPayload, {
    "x-hub-signature-256": `sha256=${sign(reviewPayload, "gh-hook-secret")}`,
  });
  expect(res.status).toBe(503);
  expect(log).toHaveBeenCalledExactlyOnceWith(
    "[ingress] github rejected reason=configuration event=unknown",
  );
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
  expect(log).toHaveBeenCalledExactlyOnceWith(
    "[ingress] linear rejected reason=signature",
  );
});

test("a validly signed Comment delivery for an unclaimed issue is acknowledged", async () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const body = commentPayload();
  const issueId = (JSON.parse(body) as { data: { issueId: string } }).data
    .issueId;
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
  const issueId = (JSON.parse(body) as { data: { issueId: string } }).data
    .issueId;
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
  expect(log).toHaveBeenCalledExactlyOnceWith(
    "[ingress] linear ignored reason=unrecognized-shape",
  );
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
  expect(body.inputs.properties.ticket).toBeDefined();
  expect(body.inputs.required).toEqual(["ticket"]);
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
    // No start-world plugin has run here, so the boot has not begun: live,
    // but not what `jigs service start` waits for.
    ready: false,
    phase: "starting",
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
  const res = await app.request("/api/runs");
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    runs: [],
    worktrees: [],
    schedules: [],
  });
});

test("GET /api/runs/:ref/steps answers with the run's steps and its dead jobs", async () => {
  setWorld({
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

test("a steps request for a run nobody launched answers on the ref", async () => {
  const res = await app.request(`/api/runs/${RUN}/steps`);
  expect(res.status).toBe(404);
});

test("GET /api/runs/:ref reports a stalled run as stalled, like `jigs ps` does", async () => {
  // `jigs ps` and `jigs logs` must not disagree about the same run, so both
  // read the one derivation in runs.ts.
  setWorld({
    runs: { get: async () => ({ status: "running" }) },
    steps: { list: async () => ({ data: [] }) },
    hooks: { list: async () => ({ data: [] }) },
  } as unknown as Parameters<typeof setWorld>[0]);
  vi.spyOn(stalls, "listJobRunIds").mockResolvedValue({
    dead: [RUN],
    live: [],
  });

  const res = await app.request(`/api/runs/${RUN}`);

  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({
    runId: RUN,
    status: "stalled",
    suspended: false,
  });
});

const CLAIM = ticketToken("68bc9696-35d5-442d-ab56-214c8cfefbec");
const MARKER = needsHumanToken("68bc9696-35d5-442d-ab56-214c8cfefbec", "c1");
const PR = prToken({ owner: "acme", repo: "api", number: 41 });

// A running run holding exactly these hooks. The routes below read no other
// world surface, so anything they touch beyond `hooks.list` rejects and is
// reported rather than thrown.
const runHolding = (...tokens: string[]) =>
  setWorld({
    runs: { get: async () => ({ status: "running" }) },
    steps: { list: async () => ({ data: [] }) },
    hooks: { list: async () => ({ data: tokens.map((token) => ({ token })) }) },
    events: { create: async () => undefined },
  } as unknown as Parameters<typeof setWorld>[0]);

test("GET /api/runs/:ref reads every park and its reason off the hook token", async () => {
  runHolding(CLAIM, MARKER, PR);

  const res = await app.request(`/api/runs/${RUN}`);

  expect(res.status).toBe(200);
  // The claim is held for the run's whole life, so it is no suspension and
  // never appears; the other two explain themselves without a metadata read.
  expect(await res.json()).toMatchObject({
    status: "suspended",
    suspended: true,
    suspensions: [
      { token: MARKER, reason: "needs a human on the ticket" },
      { token: PR, reason: "awaiting pull request review" },
    ],
  });
});

test("a run holding only its ticket claim is running, not suspended", async () => {
  runHolding(CLAIM);

  const res = await app.request(`/api/runs/${RUN}`);

  expect(await res.json()).toMatchObject({
    status: "running",
    suspended: false,
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

test("cancel names the resources it released, and not the marker", async () => {
  runHolding(CLAIM, MARKER);

  const res = await app.request(`/api/runs/${RUN}/cancel`, { method: "POST" });

  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ releasedTokens: [CLAIM] });
});

test("GET /api/schedules answers with what the factory declared, and what is next", async () => {
  const res = await scheduledApp.request("/api/schedules");
  expect(res.status).toBe(200);
  const body = (await res.json()) as Array<{
    name: string;
    pipeline: string;
    cron: string;
    next: string | null;
    active: string | null;
  }>;
  expect(body.map((s) => s.name)).toEqual(["nightly-plain", "broken-cron"]);
  expect(body[0]).toMatchObject({
    name: "nightly-plain",
    pipeline: "plain",
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

test("POST /api/worktrees/sweep answers an empty report when the registry holds nothing", async () => {
  const res = await app.request("/api/worktrees/sweep", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ clean: false, force: false }),
  });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    entries: [],
    removed: [],
    removedDirs: [],
  });
});
