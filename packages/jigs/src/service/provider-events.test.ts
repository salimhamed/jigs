import { readFileSync } from "node:fs";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { resumeHook } from "workflow/api";
import { HookNotFoundError } from "workflow/errors";
import { z } from "zod";
import { useGithubClient } from "../providers/test-fixtures.ts";
import { testFactoryContext } from "../test-fixtures.ts";
import type { Factory } from "../workflow/factory.ts";
import { pagerduty } from "../workflow/pagerduty/source.ts";
import { pullRequestToken } from "../workflow/pull-requests/pull-request.ts";
import * as triggers from "./event-triggers/runner.ts";
import type { PreparedRun } from "./launch.ts";
import { pagerDutyIncidents } from "./pagerduty-incidents.ts";
import { type ProviderEvent, routeProviderEvent } from "./provider-events.ts";
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
const route = (event: ProviderEvent) => routeProviderEvent(event, { context, push });

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
const github = (name: string, payload: unknown): ProviderEvent => ({
  provider: "github",
  name,
  payload,
});

test("a PR review nobody is listening to is dropped, and dropped again on redelivery", async () => {
  expect(await route(github("pull_request_review", review))).toEqual({ outcome: "dropped" });
  expect(log).toHaveBeenLastCalledWith(
    "[ingress] github dropped reason=no-matching-hook token=github:pr:acme/api#41 event=pull_request_review",
  );
  expect(await route(github("pull_request_review", review))).toEqual({ outcome: "dropped" });
  expect(log).toHaveBeenCalledTimes(2);
});

test("a GitHub event matching a hook wakes it, logs its token and notes the wake", async () => {
  clearWakes();
  delivers();
  expect(await route(github("pull_request_review", review))).toEqual({ outcome: "woken" });
  expect(log).toHaveBeenCalledExactlyOnceWith(
    "[ingress] github accepted token=github:pr:acme/api#41 event=pull_request_review",
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
    "[ingress] github dropped reason=delivery-failed token=github:pr:acme/api#41 event=pull_request_review",
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
  expect(log).toHaveBeenCalledWith("[ingress] github ignored reason=pending-status event=status");
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
    "[ingress] github dropped reason=status-lookup-failed event=status",
  );
});

test("an unroutable GitHub event is ignored", async () => {
  const ping = { zen: "Keep it logically awesome.", hook_id: 1, repository: review.repository };
  expect(await route(github("ping", ping))).toEqual({ outcome: "ignored" });
  expect(log).toHaveBeenCalledExactlyOnceWith(
    "[ingress] github ignored reason=unrecognized-event event=ping",
  );
});

const comment = () => {
  const issueId = crypto.randomUUID();
  const event: ProviderEvent = {
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
    `[ingress] linear dropped reason=no-matching-hook token=linear:ticket:${issueId} event=Comment`,
  );
});

test("a Linear comment matching a hook wakes it and logs its token", async () => {
  delivers();
  const { issueId, event } = comment();
  expect(await route(event)).toEqual({ outcome: "woken" });
  expect(log).toHaveBeenCalledExactlyOnceWith(
    `[ingress] linear accepted token=linear:ticket:${issueId} event=Comment`,
  );
});

test("a Linear event without a body is ignored", async () => {
  expect(await route({ provider: "linear", name: "", payload: null })).toEqual({
    outcome: "ignored",
  });
  expect(log).toHaveBeenCalledExactlyOnceWith("[ingress] linear ignored reason=unrecognized-shape");
});

test("an unroutable Linear resource type is ignored", async () => {
  const payload = { action: "update", type: "Issue", data: { id: "issue-1" } };
  expect(await route({ provider: "linear", name: "Issue", payload })).toEqual({
    outcome: "ignored",
  });
  expect(log).toHaveBeenCalledExactlyOnceWith(
    "[ingress] linear ignored reason=unrecognized-event event=Issue",
  );
});

const incidentTriggered = () =>
  JSON.parse(
    readFileSync(new URL("./fixtures/pagerduty-incident-triggered.json", import.meta.url), "utf8"),
  ) as { event: { event_type: string } };
const page = (payload = incidentTriggered()): ProviderEvent => ({
  provider: "pagerduty",
  name: payload.event.event_type,
  payload,
});

test("a PagerDuty event no trigger takes is ignored", async () => {
  const payload = incidentTriggered();
  payload.event.event_type = "incident.acknowledged";
  expect(await route(page(payload))).toEqual({ outcome: "ignored" });
  expect(log).toHaveBeenCalledExactlyOnceWith(
    "[ingress] pagerduty ignored reason=no-new-occurrence-or-unreadable event=incident.acknowledged",
  );
});

test("a PagerDuty push that fails is a failure, logged", async () => {
  push.mockRejectedValueOnce(new Error("registry unreachable"));
  expect(await route(page())).toEqual({ outcome: "failed" });
  expect(log).toHaveBeenCalledExactlyOnceWith(
    "[ingress] pagerduty dropped reason=push-failed event=incident.triggered: Error: registry unreachable",
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
      "pagerduty.incidents": pagerDutyIncidents({
        client: () => ({ listIncidents: async () => [] }) as never,
        now: () => T0,
      }),
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
    intervalSeconds: async () => ({ github: 300, linear: 300, slack: 300, pagerduty: 300 }),
    random: () => 0,
    setTimer: (_fire, ms) => {
      timers.push(ms);
      return () => {};
    },
  });
  await vi.waitFor(() => expect(timers).toHaveLength(2));

  expect(await route(page())).toEqual({ outcome: "triggered", triggers: ["pages"] });
  expect(log).toHaveBeenCalledWith(
    "[ingress] pagerduty accepted triggers=pages event=incident.triggered",
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
const slack = (payload = reply): ProviderEvent => ({ provider: "slack", name: "message", payload });

test("a Slack message goes to the triggers and wakes the thread it replies in", async () => {
  delivers();
  expect(await route(slack())).toEqual({ outcome: "woken" });
  expect(push).toHaveBeenCalledExactlyOnceWith("slack", reply);
  expect(resumeHookMock).toHaveBeenCalledExactlyOnceWith(
    "slack:thread:C0C5EUZ7P9Q:1790723478.961719",
    undefined,
  );
});

test("a Slack message a trigger takes reports the trigger", async () => {
  push.mockResolvedValueOnce(["questions"]);
  expect(await route(slack({ ...reply, thread_ts: undefined } as never))).toEqual({
    outcome: "triggered",
    triggers: ["questions"],
  });
});

test("a Slack push that fails still wakes the thread, and is logged", async () => {
  delivers();
  push.mockRejectedValueOnce(new Error("registry unreachable"));
  expect(await route(slack())).toEqual({ outcome: "failed" });
  expect(resumeHookMock).toHaveBeenCalledOnce();
  expect(log).toHaveBeenCalledWith(
    "[slack] could not start runs for C0C5EUZ7P9Q:1790723501.000300: Error: registry unreachable",
  );
});
