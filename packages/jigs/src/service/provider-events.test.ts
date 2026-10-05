import { readFileSync } from "node:fs";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { resumeHook } from "workflow/api";
import { HookNotFoundError } from "workflow/errors";
import { z } from "zod";
import * as githubApi from "../providers/github.ts";
import { GitHubApiError } from "../providers/github-http.ts";
import { HubResponseError } from "../providers/hub.ts";
import { useGithubClient } from "../providers/test-fixtures.ts";
import { testFactoryContext } from "../test-fixtures.ts";
import type { Factory } from "../workflow/factory.ts";
import { pagerduty } from "../workflow/pagerduty/source.ts";
import { pullRequestToken } from "../workflow/pull-requests/pull-request.ts";
import * as triggers from "./event-triggers/runner.ts";
import type { PreparedRun } from "./launch.ts";
import { PAGERDUTY_INCIDENTS } from "./pagerduty-incidents.ts";
import { type RoutedEvent, routeProviderEvent } from "./provider-events.ts";
import { eventTriggerId } from "./runs.ts";
import { memoryTriggerStore } from "./test-fixtures.ts";
import { clearWakes, lastWake } from "./wake.ts";

// What an event is worth is what the SDK's resumeHook answers, so the SDK is
// what a test stands in for here.
vi.mock("workflow/api", () => ({ resumeHook: vi.fn() }));
const resumeHookMock = vi.mocked(resumeHook);

const RUN = "wrun_01K3ANBZ4TQ8W9YV6H2E5C7DKM";
const delivers = () => resumeHookMock.mockResolvedValueOnce({ runId: RUN } as never);

const context = testFactoryContext({ slug: "factory-test", env: { GITHUB_TOKEN: "gh-token" } });
const push = vi.fn(triggers.pushEvent);
const route = (event: RoutedEvent) => routeProviderEvent(event, { context, push });

let log: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  push.mockReset().mockImplementation(triggers.pushEvent);
  resumeHookMock.mockReset().mockRejectedValue(new HookNotFoundError("unclaimed-test-token"));
  log = vi.spyOn(console, "log").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
});

const review = {
  action: "submitted",
  review: { id: 7, state: "approved" },
  pull_request: { number: 41 },
  repository: { name: "api", owner: { login: "acme" } },
};
const github = (name: string, payload: unknown): RoutedEvent => ({
  provider: "github",
  name,
  payload,
});

test("a PR review nobody is listening to is dropped, and dropped again on redelivery", async () => {
  expect(await route(github("pull_request_review", review))).toEqual({ outcome: "dropped" });
  expect(log).toHaveBeenLastCalledWith(
    "[events] github dropped reason=no-matching-hook token=github:pr:acme/api#41 event=pull_request_review",
  );
  expect(await route(github("pull_request_review", review))).toEqual({ outcome: "dropped" });
  expect(log).toHaveBeenCalledTimes(2);
});

test("a GitHub event matching a hook wakes it, logs its token and notes the wake", async () => {
  clearWakes();
  delivers();
  expect(await route(github("pull_request_review", review))).toEqual({ outcome: "woken" });
  expect(log).toHaveBeenCalledExactlyOnceWith(
    "[events] github accepted token=github:pr:acme/api#41 event=pull_request_review",
  );
  expect(lastWake("github:pr:acme/api#41", RUN)?.kind).toBe("github pull_request_review");
});

test("GitHub's canonical casing resumes a hook claimed from a lowercase remote", async () => {
  delivers();
  const payload = {
    ...review,
    pull_request: { number: 1 },
    repository: { name: "Data-Lake-Airflow", owner: { login: "Junglescout" } },
  };
  expect(await route(github("pull_request_review", payload))).toEqual({ outcome: "woken" });
  expect(resumeHookMock).toHaveBeenCalledExactlyOnceWith(
    "github:pr:junglescout/data-lake-airflow#1",
    undefined,
  );
});

test("a GitHub wake failure is not misreported as a missing hook", async () => {
  resumeHookMock.mockRejectedValueOnce(new Error("database unavailable"));
  expect(await route(github("pull_request_review", review))).toEqual({ outcome: "failed" });
  expect(log).toHaveBeenCalledExactlyOnceWith(
    "[events] github dropped reason=delivery-failed token=github:pr:acme/api#41 event=pull_request_review",
  );
});

test("a check_suite event is routed to the PR it belongs to", async () => {
  const payload = {
    action: "completed",
    check_suite: { id: 9, conclusion: "failure", pull_requests: [{ number: 41 }] },
    repository: { name: "api", owner: { login: "acme" } },
  };
  expect(await route(github("check_suite", payload))).toEqual({ outcome: "dropped" });
  expect(resumeHookMock).toHaveBeenCalledExactlyOnceWith("github:pr:acme/api#41", undefined);
});

const status = (state: string) =>
  github("status", {
    sha: "status-sha",
    state,
    context: "AWS CodeBuild us-west-2",
    repository: { name: "fork", full_name: "contributor/fork", owner: { login: "contributor" } },
  });

test("a status resolves every matching PR and routes by base repo", async () => {
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
  useGithubClient({ fetch: fetchMock });
  resumeHookMock
    .mockResolvedValueOnce({} as never)
    .mockRejectedValueOnce(new HookNotFoundError("unclaimed"));

  expect(await route(status("failure"))).toEqual({ outcome: "woken" });
  expect(resumeHookMock.mock.calls.map(([token]) => token).sort()).toEqual(
    [
      pullRequestToken({ owner: "acme", repo: "api", number: 41 }),
      pullRequestToken({ owner: "acme", repo: "web", number: 7 }),
    ].sort(),
  );
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test("a pending status is ignored without a sha lookup", async () => {
  const fetchMock = vi.fn();
  useGithubClient({ fetch: fetchMock });
  expect(await route(status("pending"))).toEqual({ outcome: "ignored" });
  expect(fetchMock).not.toHaveBeenCalled();
  expect(resumeHookMock).not.toHaveBeenCalled();
  expect(log).toHaveBeenCalledWith("[events] github ignored reason=pending-status event=status");
});

test("a status with no open PR is dropped without waking anything", async () => {
  useGithubClient({ fetch: vi.fn().mockResolvedValue(new Response("[]")) });
  expect(await route(status("success"))).toEqual({ outcome: "dropped" });
  expect(resumeHookMock).not.toHaveBeenCalled();
});

test("a status lookup failure fails rather than throws", async () => {
  useGithubClient({ fetch: vi.fn().mockRejectedValue(new Error("network down")) });
  expect(await route(status("failure"))).toEqual({ outcome: "failed" });
  expect(log).toHaveBeenCalledWith(
    "[events] github dropped reason=status-lookup-failed event=status",
  );
});

test.each([
  ["the hub has no installation for the repository", new HubResponseError(404, "no installation")],
  ["the hub has more than one", new HubResponseError(409, "ambiguous installation")],
  ["GitHub refuses the request", new GitHubApiError(404, "/repos/acme/api/commits/x/pulls", "{}")],
  ["GitHub cannot process it", new GitHubApiError(422, "/repos/acme/api/commits/x/pulls", "{}")],
])("a status lookup refused for good is ignored loudly, not retried: %s", async (_name, error) => {
  const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(githubApi, "findOpenPullRequestsByHeadSha").mockRejectedValue(error);
  expect(await route(status("success"))).toEqual({ outcome: "ignored" });
  expect(errors).toHaveBeenCalledWith(
    expect.stringContaining("[events] github ignored reason=status-lookup-refused event=status"),
  );
});

test.each([
  ["the hub is down", new HubResponseError(503, "unavailable")],
  [
    "GitHub rejects the credential",
    new GitHubApiError(401, "/repos/acme/api/commits/x/pulls", "{}"),
  ],
  ["GitHub is rate limiting", new GitHubApiError(429, "/repos/acme/api/commits/x/pulls", "{}")],
  ["GitHub errs", new GitHubApiError(502, "/repos/acme/api/commits/x/pulls", "{}")],
])("a status lookup that may pass later fails, to be retried: %s", async (_name, error) => {
  vi.spyOn(githubApi, "findOpenPullRequestsByHeadSha").mockRejectedValue(error);
  expect(await route(status("success"))).toEqual({ outcome: "failed" });
});

test("a GitHub 403 for its rate limit is retried; any other 403 is ignored", async () => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  const forbidden = (headers: Record<string, string>) =>
    useGithubClient({
      fetch: vi.fn().mockImplementation(async () => new Response("{}", { status: 403, headers })),
      sleep: async () => {},
    });
  forbidden({ "retry-after": "3600" });
  expect(await route(status("success"))).toEqual({ outcome: "failed" });
  forbidden({ "x-ratelimit-remaining": "0", "x-ratelimit-reset": "99999999999" });
  expect(await route(status("success"))).toEqual({ outcome: "failed" });
  forbidden({});
  expect(await route(status("success"))).toEqual({ outcome: "ignored" });
});

test("an unroutable GitHub event is ignored", async () => {
  const ping = { zen: "Keep it logically awesome.", hook_id: 1, repository: review.repository };
  expect(await route(github("ping", ping))).toEqual({ outcome: "ignored" });
  expect(log).toHaveBeenCalledExactlyOnceWith(
    "[events] github ignored reason=unrecognized-event event=ping",
  );
});

const comment = () => {
  const issueId = crypto.randomUUID();
  const event: RoutedEvent = {
    provider: "linear",
    name: "Comment",
    payload: { action: "create", type: "Comment", data: { id: "c1", body: "reply", issueId } },
  };
  return { issueId, event };
};

test("a Linear comment on an unclaimed issue is dropped", async () => {
  const { issueId, event } = comment();
  expect(await route(event)).toEqual({ outcome: "dropped" });
  expect(log).toHaveBeenCalledExactlyOnceWith(
    `[events] linear dropped reason=no-matching-hook token=linear:ticket:${issueId} event=Comment`,
  );
});

test("a Linear comment matching a hook wakes it and logs its token", async () => {
  delivers();
  const { issueId, event } = comment();
  expect(await route(event)).toEqual({ outcome: "woken" });
  expect(log).toHaveBeenCalledExactlyOnceWith(
    `[events] linear accepted token=linear:ticket:${issueId} event=Comment`,
  );
});

test("a Linear event without a body is ignored", async () => {
  expect(await route({ provider: "linear", name: "", payload: null })).toEqual({
    outcome: "ignored",
  });
  expect(log).toHaveBeenCalledExactlyOnceWith("[events] linear ignored reason=unrecognized-shape");
});

test("an unroutable Linear resource type is ignored", async () => {
  const payload = { action: "update", type: "Issue", data: { id: "issue-1" } };
  expect(await route({ provider: "linear", name: "Issue", payload })).toEqual({
    outcome: "ignored",
  });
  expect(log).toHaveBeenCalledExactlyOnceWith(
    "[events] linear ignored reason=unrecognized-event event=Issue",
  );
});

test("a Linear agent session goes to the triggers, not to waiting runs", async () => {
  push.mockResolvedValueOnce(["mentions"]);
  const payload = { type: "AgentSessionEvent", action: "created", agentSession: { id: "s1" } };
  expect(await route({ provider: "linear", name: "AgentSessionEvent", payload })).toEqual({
    outcome: "triggered",
    triggers: ["mentions"],
  });
  expect(push).toHaveBeenCalledExactlyOnceWith("linear", payload);
  expect(resumeHookMock).not.toHaveBeenCalled();
  expect(log).toHaveBeenCalledExactlyOnceWith(
    "[events] linear accepted triggers=mentions event=AgentSessionEvent",
  );
});

test("a Linear agent session no trigger could read is a failure, logged", async () => {
  push.mockRejectedValueOnce(new Error("issue lookup failed"));
  const payload = { type: "AgentSessionEvent", action: "created", agentSession: { id: "s1" } };
  expect(await route({ provider: "linear", name: "AgentSessionEvent", payload })).toEqual({
    outcome: "failed",
  });
  expect(log).toHaveBeenCalledExactlyOnceWith(
    "[events] linear dropped reason=push-failed event=AgentSessionEvent: Error: issue lookup failed",
  );
});

const incidentTriggered = () =>
  JSON.parse(
    readFileSync(new URL("./fixtures/pagerduty-incident-triggered.json", import.meta.url), "utf8"),
  ) as { event: { event_type: string } };
const page = (payload = incidentTriggered()): RoutedEvent => ({
  provider: "pagerduty",
  name: payload.event.event_type,
  payload,
});

test("a PagerDuty event no trigger takes is ignored", async () => {
  const payload = incidentTriggered();
  payload.event.event_type = "incident.acknowledged";
  expect(await route(page(payload))).toEqual({ outcome: "ignored" });
  expect(log).toHaveBeenCalledExactlyOnceWith(
    "[events] pagerduty ignored reason=no-new-occurrence event=incident.acknowledged",
  );
});

test("a PagerDuty push that fails is a failure, logged", async () => {
  push.mockRejectedValueOnce(new Error("registry unreachable"));
  expect(await route(page())).toEqual({ outcome: "failed" });
  expect(log).toHaveBeenCalledExactlyOnceWith(
    "[events] pagerduty dropped reason=push-failed event=incident.triggered: Error: registry unreachable",
  );
});

// Each run starts from an incident on the one service the trigger watches.
const paged = {
  workflows: {
    respond: { workflow: async () => undefined, inputs: z.object({ incident: z.string() }) },
  },
  triggers: {
    pages: { workflow: "respond", source: pagerduty.incidents({ service_ids: ["PSVC001"] }) },
  },
} satisfies Factory;

test("an incident.triggered is recorded at once, and its run starts", async () => {
  const T0 = new Date("2026-09-29T12:00:00.000Z");
  const memory = memoryTriggerStore(() => T0, T0);
  const starts: Array<{ inputs: unknown; triggerId: string }> = [];
  const timers: number[] = [];
  let release = () => {};
  const started = new Promise<void>((resolve) => {
    release = resolve;
  });
  triggers.startTriggers(paged, {
    store: memory.store,
    sources: {
      "pagerduty.incidents": PAGERDUTY_INCIDENTS,
    },
    now: () => T0,
    log: () => {},
    factorySlug: () => "factory-test",
    runStatuses: async () => new Map(),
    findRunsByAttribute: async () => [],
    liveRunsByAttribute: async () => new Map(),
    cancelRun: async () => {},
    prepareRun: async (_factory, _workflow, inputs): Promise<PreparedRun> => ({
      kind: "ready",
      launch: async (triggerId) => {
        // Held open: routing must not wait on the start.
        await started;
        starts.push({ inputs, triggerId });
        return "wrun_1";
      },
    }),
    ready: async () => {},
    setTimer: (_fire, ms) => {
      timers.push(ms);
      return () => {};
    },
  });
  await vi.waitFor(() => expect(timers).toHaveLength(1));

  expect(await route(page())).toEqual({ outcome: "triggered", triggers: ["pages"] });
  expect(log).toHaveBeenCalledWith(
    "[events] pagerduty accepted triggers=pages event=incident.triggered",
  );
  expect(memory.state("pages", "Q1")).toMatchObject({ state: "pending" });
  expect(starts).toEqual([]);
  release();
  await vi.waitFor(() =>
    expect(starts).toEqual([
      { inputs: { incident: "Q1" }, triggerId: eventTriggerId("pages", "Q1") },
    ]),
  );
});

const reply = {
  type: "message",
  channel: "C0C5EUZ7P9Q",
  channel_type: "channel",
  user: "U01PW925E6N",
  text: "the payments team",
  ts: "1790723501.000300",
  thread_ts: "1790723478.961719",
};
// The Events API body the hub sends on.
const callback = (event: object) => ({
  type: "event_callback",
  api_app_id: "A0C5JPZUW1J",
  team_id: "T0A7SCMC5",
  event,
});
const slack = (event: object = reply): RoutedEvent => ({
  provider: "slack",
  name: "message",
  payload: callback(event),
});

const THREAD = "slack:thread:C0C5EUZ7P9Q:1790723478.961719";

test("a Slack message goes to the triggers and wakes the thread it replies in", async () => {
  delivers();
  expect(await route(slack())).toEqual({ outcome: "woken" });
  expect(push).toHaveBeenCalledExactlyOnceWith("slack", callback(reply));
  expect(resumeHookMock).toHaveBeenCalledExactlyOnceWith(THREAD, undefined);
  expect(lastWake(THREAD, RUN)?.kind).toBe("slack message");
  expect(log).toHaveBeenCalledWith(`[events] slack accepted token=${THREAD} event=message`);
});

test("a reply in a thread no run waits on is dropped", async () => {
  expect(await route(slack())).toEqual({ outcome: "dropped" });
  expect(log).toHaveBeenCalledWith(
    `[events] slack dropped reason=no-matching-hook token=${THREAD} event=message`,
  );
});

test("a top-level message or a bot's reply wakes nothing", async () => {
  expect(await route(slack({ ...reply, thread_ts: undefined }))).toEqual({ outcome: "ignored" });
  expect(await route(slack({ ...reply, bot_id: "B0C5JPZUW1J" }))).toEqual({ outcome: "ignored" });
  expect(resumeHookMock).not.toHaveBeenCalled();
});

test("a Slack wake that fails fails the routing, so the message is routed again", async () => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  resumeHookMock.mockRejectedValueOnce(new Error("world down"));
  push.mockResolvedValueOnce(["questions"]);
  expect(await route(slack())).toEqual({ outcome: "failed" });
  expect(log).toHaveBeenCalledWith(
    `[events] slack dropped reason=delivery-failed token=${THREAD} event=message`,
  );
});

test("a Slack message a trigger takes reports the trigger", async () => {
  push.mockResolvedValueOnce(["questions"]);
  expect(await route(slack({ ...reply, thread_ts: undefined }))).toEqual({
    outcome: "triggered",
    triggers: ["questions"],
  });
});

test("a Slack push that fails still wakes the thread, which is what routing reports", async () => {
  delivers();
  push.mockRejectedValueOnce(new Error("registry unreachable"));
  expect(await route(slack())).toEqual({ outcome: "woken" });
  expect(resumeHookMock).toHaveBeenCalledOnce();
  expect(log).toHaveBeenCalledWith(
    "[events] slack dropped reason=push-failed channel=C0C5EUZ7P9Q ts=1790723501.000300: Error: registry unreachable",
  );
});

test("a Slack push that fails with no thread woken fails the routing", async () => {
  push.mockRejectedValueOnce(new Error("registry unreachable"));
  expect(await route(slack({ ...reply, thread_ts: undefined }))).toEqual({ outcome: "failed" });
});
