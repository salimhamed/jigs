import { beforeEach, expect, test } from "vitest";
import { createHubTokens } from "./credentials.ts";
import { createLinearClient } from "./linear.ts";
import { createLinearAgentApi } from "./linear-agent.ts";
import { createLinearAuth } from "./linear-auth.ts";
import { fakeFetch, jsonResponse } from "./test-support.ts";

let replies: Response[];
let server: ReturnType<typeof fakeFetch>;
let agent: ReturnType<typeof createLinearAgentApi>;

beforeEach(() => {
  replies = [];
  server = fakeFetch(() => {
    const reply = replies.shift();
    if (reply === undefined) throw new Error("no reply queued");
    return reply;
  });
  agent = createLinearAgentApi(
    createLinearClient({
      installationName: "acme",
      auth: createLinearAuth(
        createHubTokens(async () => ({
          token: "lin_oauth",
          expiresAt: "2999-01-01T00:00:00Z",
          app: { name: "jigs", userId: "app-user" },
        })),
      ),
      fetch: server.fetch,
    }),
  );
});

const respond = (data: unknown) => replies.push(jsonResponse({ data }));
// biome-ignore lint/suspicious/noExplicitAny: request bodies are asserted field by field
const bodies = (): any[] => server.calls.map((call) => call.json);

test("an activity is created in the session with its content, id and ephemerality", async () => {
  respond({
    agentActivityCreate: {
      success: true,
      agentActivity: { id: "a1", createdAt: "2026-10-07T00:00:00Z" },
    },
  });
  const posted = await agent.postActivity(
    "session-1",
    { type: "action", action: "Reading", parameter: "src/app.ts" },
    { ephemeral: true, id: "a1" },
  );
  expect(posted).toEqual({ id: "a1", createdAt: "2026-10-07T00:00:00Z" });
  expect(bodies()[0].query).toContain("agentActivityCreate(input: $input)");
  expect(bodies()[0].variables).toEqual({
    input: {
      agentSessionId: "session-1",
      content: { type: "action", action: "Reading", parameter: "src/app.ts" },
      ephemeral: true,
      id: "a1",
    },
  });
});

test("a response or an error cannot be ephemeral, and nothing is sent", async () => {
  await expect(
    agent.postActivity("session-1", { type: "response", body: "Done." }, { ephemeral: true }),
  ).rejects.toThrow("a Linear agent response cannot be ephemeral");
  await expect(
    agent.postActivity("session-1", { type: "error", body: "Broke." }, { ephemeral: true }),
  ).rejects.toThrow("cannot be ephemeral");
  expect(server.calls).toHaveLength(0);
});

test("a refused activity is an error", async () => {
  respond({ agentActivityCreate: { success: false, agentActivity: null } });
  await expect(agent.postActivity("session-1", { type: "thought", body: "Hm" })).rejects.toThrow(
    "agentActivityCreate failed for session session-1",
  );
});

test("an activity posted once is created under its id", async () => {
  respond({ agentActivityCreate: { success: true, agentActivity: { id: "a1", createdAt: "t1" } } });
  expect(await agent.postActivityOnce("session-1", { type: "response", body: "Hi" }, "a1")).toEqual(
    { id: "a1", createdAt: "t1" },
  );
  expect(bodies()[0].variables.input.id).toBe("a1");
  expect(server.calls).toHaveLength(1);
});

test("an activity whose id already exists is the one found, not a second post", async () => {
  replies.push(jsonResponse({ errors: [{ message: "Entity already exists" }] }));
  respond({ agentActivities: { nodes: [{ id: "a1", createdAt: "t1" }] } });
  expect(await agent.postActivityOnce("session-1", { type: "response", body: "Hi" }, "a1")).toEqual(
    { id: "a1", createdAt: "t1" },
  );
});

test("a post that failed and left nothing behind fails", async () => {
  replies.push(jsonResponse({ errors: [{ message: "Linear is down" }] }));
  respond({ agentActivities: { nodes: [] } });
  await expect(
    agent.postActivityOnce("session-1", { type: "response", body: "Hi" }, "a1"),
  ).rejects.toThrow("Linear is down");
});

test("an activity is found by id, or is null when Linear has none", async () => {
  respond({ agentActivities: { nodes: [{ id: "a1", createdAt: "t1" }] } });
  respond({ agentActivities: { nodes: [] } });
  expect(await agent.findActivity("a1")).toEqual({ id: "a1", createdAt: "t1" });
  expect(await agent.findActivity("a2")).toBeNull();
  expect(bodies()[0].variables).toEqual({ id: "a1" });
});

test("the session's links are replaced with exactly the labels and URLs given", async () => {
  respond({ agentSessionUpdate: { success: true } });
  await agent.setExternalUrls("session-1", [
    { label: "Pull request", url: "https://github.com/acme/api/pull/1" },
  ]);
  expect(bodies()[0].query).toContain("agentSessionUpdate(id: $id, input: $input)");
  expect(bodies()[0].variables).toEqual({
    id: "session-1",
    input: { externalUrls: [{ label: "Pull request", url: "https://github.com/acme/api/pull/1" }] },
  });
});

test("a session is opened on the issue with its links, so Linear starts it at once", async () => {
  respond({ agentSessionCreateOnIssue: { success: true, agentSession: { id: "session-2" } } });
  const links = [{ label: "jigs run", url: "https://jigs.example/runs/r1" }];
  expect(await agent.createSession("issue-1", links)).toBe("session-2");
  expect(bodies()[0].variables).toEqual({ input: { issueId: "issue-1", externalUrls: links } });
});

const prompt = (id: string, createdAt: string, extra: Record<string, unknown> = {}) => ({
  id,
  createdAt,
  signal: null,
  content: { __typename: "AgentActivityPromptContent", body: `body ${id}` },
  user: { id: "u1", name: "Ada" },
  sourceComment: { id: `comment-${id}` },
  ...extra,
});

test("prompts are read page by page and listed oldest first", async () => {
  respond({
    agentSession: {
      activities: {
        nodes: [
          prompt("p3", "2026-10-07T00:03:00.000Z", {
            signal: "stop",
            content: { __typename: "AgentActivityPromptContent", body: "stop" },
            sourceComment: null,
          }),
          prompt("p2", "2026-10-07T00:02:00.000Z"),
        ],
        pageInfo: { hasNextPage: true, endCursor: "c1" },
      },
    },
  });
  respond({
    agentSession: {
      activities: {
        nodes: [
          prompt("p1", "2026-10-07T00:01:00.000Z"),
          {
            ...prompt("t1", "2026-10-07T00:00:30.000Z"),
            content: { __typename: "AgentActivityThoughtContent" },
          },
        ],
        pageInfo: { hasNextPage: false, endCursor: "c2" },
      },
    },
  });

  const prompts = await agent.listPrompts("session-1");

  expect(prompts.map((p) => p.id)).toEqual(["p1", "p2", "p3"]);
  expect(prompts[0]).toEqual({
    id: "p1",
    createdAt: "2026-10-07T00:01:00.000Z",
    body: "body p1",
    signal: null,
    author: { id: "u1", name: "Ada" },
    sourceCommentId: "comment-p1",
  });
  expect(prompts[2]).toMatchObject({ body: "stop", signal: "stop", sourceCommentId: null });
  expect(bodies()[0].query).toContain('filter: { type: { eq: "prompt" } }');
  expect(bodies().map((body) => body.variables.after)).toEqual([null, "c1"]);
});

test("a session is answered after a time only by a later response or error", async () => {
  respond({ agentSession: { activities: { nodes: [{ id: "r1" }] } } });
  respond({ agentSession: { activities: { nodes: [] } } });
  expect(await agent.answeredSince("session-1", "2026-10-07T00:00:00.000Z")).toBe(true);
  expect(await agent.answeredSince("session-1", "2026-10-07T00:00:00.000Z")).toBe(false);
  expect(bodies()[0].query).toContain('type: { in: ["response", "error"] }');
  expect(bodies()[0].variables).toEqual({ id: "session-1", since: "2026-10-07T00:00:00.000Z" });
});

test("the app's last activity is its newest non-prompt one, by type, or null before any", async () => {
  respond({
    agentSession: {
      activities: {
        nodes: [
          {
            createdAt: "2026-10-07T00:00:00.000Z",
            content: { __typename: "AgentActivityElicitationContent" },
          },
        ],
      },
    },
  });
  respond({ agentSession: { activities: { nodes: [] } } });
  expect(await agent.lastAppActivity("session-1")).toEqual({
    type: "elicitation",
    createdAt: "2026-10-07T00:00:00.000Z",
  });
  expect(await agent.lastAppActivity("session-1")).toBeNull();
  expect(bodies()[0].query).not.toContain("prompt");
});
