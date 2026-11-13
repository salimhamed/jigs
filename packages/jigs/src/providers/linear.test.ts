import { beforeEach, expect, test } from "vitest";
import { createHubTokens } from "./credentials.ts";
import { ProviderApiError } from "./http.ts";
import { createLinearClient } from "./linear.ts";
import { createLinearAuth, LINEAR_API_URL } from "./linear-auth.ts";
import { type FetchCall, fakeFetch, jsonResponse } from "./test-support.ts";

let replies: Response[];
let server: ReturnType<typeof fakeFetch>;
let linear: ReturnType<typeof createLinearClient>;

beforeEach(() => {
  replies = [];
  server = fakeFetch(() => {
    const reply = replies.shift();
    if (reply === undefined) throw new Error("no reply queued");
    return reply;
  });
  linear = createLinearClient({
    installationName: "acme",
    auth: createLinearAuth(
      createHubTokens(async () => ({
        token: "lin_oauth",
        expiresAt: "2999-01-01T00:00:00Z",
        app: { name: "jigs", userId: "app-user" },
      })),
    ),
    fetch: server.fetch,
  });
});

const respond = (data: unknown) => replies.push(jsonResponse({ data }));

// biome-ignore lint/suspicious/noExplicitAny: request bodies are asserted field by field
const requestBodies = (): any[] => server.calls.map((call) => call.json);

const lastRequest = () => {
  const call = server.calls.at(-1) as FetchCall;
  // biome-ignore lint/suspicious/noExplicitAny: request bodies are asserted field by field
  return { url: call.url.toString(), headers: call.headers, body: call.json as any };
};

test("requests carry the hub's token as a bearer to Linear's GraphQL endpoint", async () => {
  respond({ issue: { creator: { id: "u1", name: "salim" } } });
  await linear.getIssueParticipants("68bc9696-35d5-442d-ab56-214c8cfefbec");
  const { url, headers } = lastRequest();
  expect(url).toBe(LINEAR_API_URL);
  expect(headers.authorization).toBe("Bearer lin_oauth");
});

test("fetchIssueSnapshot asks for the snapshot fields in one round trip", async () => {
  respond({ issue: { id: "i1", identifier: "AGE-313" } });
  const issue = await linear.fetchIssueSnapshot("issue-uuid");
  expect(issue.identifier).toBe("AGE-313");
  expect(server.calls).toHaveLength(1);
  const { url, body } = lastRequest();
  expect(url).toBe(LINEAR_API_URL);
  for (const field of [
    "branchName",
    "labels",
    "comments(last: 100)",
    "attachments",
    "children",
    "relations",
    "inverseRelations",
  ]) {
    expect(body.query).toContain(field);
  }
  expect(body.variables).toEqual({ id: "issue-uuid" });
});

test("fetchIssueStates reads the current state and its team's available states", async () => {
  respond({
    issue: {
      state: { id: "todo", name: "Todo" },
      team: {
        name: "Development",
        states: { nodes: [{ id: "done", name: "Done", type: "completed", position: 4 }] },
      },
    },
  });
  await expect(linear.fetchIssueStates("issue-uuid")).resolves.toMatchObject({
    state: { id: "todo", name: "Todo" },
    team: { name: "Development" },
  });
  const request = lastRequest().body;
  expect(request.query).toContain("IssueStates");
  expect(request.query).toContain("states { nodes { id name type position } }");
  expect(request.variables).toEqual({ id: "issue-uuid" });
});

test("updateIssueState sends the issueUpdate mutation", async () => {
  respond({ issueUpdate: { success: true } });
  await expect(linear.updateIssueState("issue-uuid", "done")).resolves.toBeUndefined();
  const request = lastRequest().body;
  expect(request.query).toContain("issueUpdate");
  expect(request.variables).toEqual({ issueId: "issue-uuid", stateId: "done" });
});

test("resolveIssueRef normalizes either accepted Linear reference", async () => {
  respond({ issue: { id: "issue-uuid", identifier: "AGE-346" } });
  await expect(linear.resolveIssueRef("AGE-346")).resolves.toEqual({
    id: "issue-uuid",
    identifier: "AGE-346",
  });
  expect(lastRequest().body.variables).toEqual({ id: "AGE-346" });
});

test("createComment posts a commentCreate mutation with the body verbatim", async () => {
  respond({
    commentCreate: {
      success: true,
      comment: { id: "c1", createdAt: "2026-08-26T12:00:00Z" },
    },
  });
  const body = "https://linear.app/acme/profiles/salim this run needs a human.";
  const comment = await linear.createComment("issue-uuid", body);
  expect(comment).toEqual({ id: "c1", createdAt: "2026-08-26T12:00:00Z" });
  const request = lastRequest().body;
  expect(request.query).toContain("commentCreate");
  expect(request.variables.input).toEqual({ issueId: "issue-uuid", body });
});

test("createComment names the comment when given an id", async () => {
  respond({ commentCreate: { success: true, comment: { id: "c-id", createdAt: "t" } } });
  await linear.createComment("issue-uuid", "hi", "c-id");
  expect(lastRequest().body.variables.input).toEqual({
    issueId: "issue-uuid",
    body: "hi",
    id: "c-id",
  });
});

const projectQuery = {
  id: "project-uuid",
  teams: { nodes: [{ id: "team-uuid" }] },
};

const createdIssue = {
  id: "issue-uuid",
  identifier: "CAI-7",
  url: "https://linear.app/acme/issue/CAI-7",
};

const teamQuery = {
  id: "team-uuid",
  states: {
    nodes: [
      { id: "triage-uuid", name: "Triage" },
      { id: "todo-uuid", name: "Todo" },
    ],
  },
};

test("createIssue resolves a project slugId then creates in its first team", async () => {
  respond({ projects: { nodes: [projectQuery] } });
  respond({ issueCreate: { success: true, issue: createdIssue } });
  await expect(
    linear.createIssue({
      project: "04889d3e87bb",
      title: "a ticket",
      description: "# body",
    }),
  ).resolves.toEqual(createdIssue);
  const [lookup, create] = requestBodies();
  expect(lookup.query).toContain("slugId: { eq: $ref } }, first: 1");
  expect(lookup.variables).toEqual({ ref: "04889d3e87bb" });
  expect(create.query).toContain("issueCreate");
  expect(create.variables.input).toEqual({
    teamId: "team-uuid",
    projectId: "project-uuid",
    title: "a ticket",
    description: "# body",
  });
});

test("createIssue looks a UUID up as the project id", async () => {
  respond({ project: projectQuery });
  respond({ issueCreate: { success: true, issue: createdIssue } });
  await linear.createIssue({
    project: "68bc9696-35d5-442d-ab56-214c8cfefbec",
    title: "a ticket",
    description: "body",
  });
  const [lookup] = requestBodies();
  expect(lookup.query).toContain("project(id: $ref)");
  expect(lookup.variables).toEqual({
    ref: "68bc9696-35d5-442d-ab56-214c8cfefbec",
  });
});

test("createIssue files into a team with no project, a status and labels", async () => {
  respond({ teams: { nodes: [teamQuery] } });
  respond({
    issueLabels: {
      nodes: [
        { id: "bug-uuid", name: "Bug" },
        { id: "qa-uuid", name: "Session quality" },
      ],
    },
  });
  respond({ issueCreate: { success: true, issue: createdIssue } });
  await expect(
    linear.createIssue({
      team: "eng",
      status: "triage",
      labels: ["Session quality", "Bug"],
      title: "a ticket",
      description: "body",
    }),
  ).resolves.toEqual(createdIssue);
  const [team, labels, create] = requestBodies();
  expect(team.query).toContain("key: { eqIgnoreCase: $ref }");
  expect(team.variables).toEqual({ ref: "eng" });
  expect(labels.query).toContain("team: { null: true }");
  expect(labels.variables).toEqual({ teamId: "team-uuid", names: ["Session quality", "Bug"] });
  expect(create.variables.input).toEqual({
    teamId: "team-uuid",
    stateId: "triage-uuid",
    labelIds: ["qa-uuid", "bug-uuid"],
    title: "a ticket",
    description: "body",
  });
});

test("createIssue looks a UUID up as the team id", async () => {
  respond({ team: teamQuery });
  respond({ issueCreate: { success: true, issue: createdIssue } });
  await linear.createIssue({
    team: "68bc9696-35d5-442d-ab56-214c8cfefbec",
    title: "a ticket",
    description: "body",
  });
  const [lookup, create] = requestBodies();
  expect(lookup.query).toContain("team(id: $id)");
  expect(create.variables.input).toEqual({
    teamId: "team-uuid",
    title: "a ticket",
    description: "body",
  });
});

test("createIssue reads the project's team states to set a status", async () => {
  respond({ projects: { nodes: [projectQuery] } });
  respond({ team: teamQuery });
  respond({ issueCreate: { success: true, issue: createdIssue } });
  await linear.createIssue({
    project: "04889d3e87bb",
    status: "Todo",
    title: "a ticket",
    description: "body",
  });
  const [, team, create] = requestBodies();
  expect(team.variables).toEqual({ id: "team-uuid" });
  expect(create.variables.input.stateId).toBe("todo-uuid");
});

test("createIssue needs a team or a project", async () => {
  await expect(linear.createIssue({ title: "t", description: "d" })).rejects.toThrow(
    "A new Linear ticket needs a team or a project",
  );
  expect(server.calls).toHaveLength(0);
});

test("createIssue throws naming the unresolvable project", async () => {
  respond({ projects: { nodes: [] } });
  await expect(
    linear.createIssue({ project: "nope", title: "t", description: "d" }),
  ).rejects.toThrow("Linear project not found: nope");
  expect(server.calls).toHaveLength(1);
});

test("createIssue throws naming the unresolvable team", async () => {
  respond({ teams: { nodes: [] } });
  await expect(linear.createIssue({ team: "NOPE", title: "t", description: "d" })).rejects.toThrow(
    "Linear team not found: NOPE",
  );
});

test("createIssue throws naming the team's statuses when the status is unknown", async () => {
  respond({ teams: { nodes: [teamQuery] } });
  await expect(
    linear.createIssue({ team: "ENG", status: "Inbox", title: "t", description: "d" }),
  ).rejects.toThrow("Linear status not found: Inbox (team has Triage, Todo)");
  expect(server.calls).toHaveLength(1);
});

test("createIssue throws naming the labels it cannot find", async () => {
  respond({ teams: { nodes: [teamQuery] } });
  respond({ issueLabels: { nodes: [{ id: "bug-uuid", name: "Bug" }] } });
  await expect(
    linear.createIssue({ team: "ENG", labels: ["Bug", "Nope"], title: "t", description: "d" }),
  ).rejects.toThrow("Linear labels not found: Nope");
  expect(server.calls).toHaveLength(2);
});

test("createIssue throws when the project carries no team", async () => {
  respond({
    projects: { nodes: [{ id: "project-uuid", teams: { nodes: [] } }] },
  });
  await expect(
    linear.createIssue({
      project: "04889d3e87bb",
      title: "t",
      description: "d",
    }),
  ).rejects.toThrow("Linear project has no team: 04889d3e87bb");
  expect(server.calls).toHaveLength(1);
});

test("createIssue throws when issueCreate reports failure", async () => {
  respond({ projects: { nodes: [projectQuery] } });
  respond({ issueCreate: { success: false, issue: null } });
  await expect(
    linear.createIssue({
      project: "04889d3e87bb",
      title: "t",
      description: "d",
    }),
  ).rejects.toThrow("Linear issueCreate failed for ticket: t");
});

const foundIssue = {
  id: "issue-uuid",
  identifier: "CAI-450",
  url: "https://linear.app/acme/issue/CAI-450",
  title: "S3: salim-dev — a finding",
  description: "# body",
  state: { name: "Todo" },
  trashed: null,
};

test("findIssue filters by project and title prefix", async () => {
  respond({ projects: { nodes: [projectQuery] } });
  respond({ issues: { nodes: [foundIssue] } });
  await expect(
    linear.findIssue({
      project: "04889d3e87bb",
      titlePrefix: "S3: salim-dev — ",
    }),
  ).resolves.toEqual({
    id: "issue-uuid",
    identifier: "CAI-450",
    url: "https://linear.app/acme/issue/CAI-450",
    title: "S3: salim-dev — a finding",
    description: "# body",
    state: "Todo",
  });
  const [lookup, find] = requestBodies();
  expect(lookup.variables).toEqual({ ref: "04889d3e87bb" });
  expect(find.query).toContain("orderBy: createdAt");
  expect(find.variables).toEqual({
    filter: { title: { startsWith: "S3: salim-dev — " }, project: { id: { eq: "project-uuid" } } },
  });
});

test("findIssue filters by team without a project", async () => {
  respond({ teams: { nodes: [teamQuery] } });
  respond({ issues: { nodes: [foundIssue] } });
  const issue = await linear.findIssue({ team: "ENG", titlePrefix: "S3: salim-dev — " });
  expect(issue?.identifier).toBe("CAI-450");
  expect(requestBodies()[1].variables).toEqual({
    filter: { title: { startsWith: "S3: salim-dev — " }, team: { id: { eq: "team-uuid" } } },
  });
});

test("findIssue needs a team or a project", async () => {
  await expect(linear.findIssue({ titlePrefix: "x" })).rejects.toThrow(
    "A Linear ticket search needs a team or a project",
  );
});

test("findIssue returns null when nothing matches", async () => {
  respond({ projects: { nodes: [projectQuery] } });
  respond({ issues: { nodes: [] } });
  await expect(
    linear.findIssue({ project: "04889d3e87bb", titlePrefix: "S3: gone — " }),
  ).resolves.toBeNull();
});

test("findIssue skips trashed matches", async () => {
  respond({ projects: { nodes: [projectQuery] } });
  respond({
    issues: {
      nodes: [
        {
          ...foundIssue,
          id: "trashed-uuid",
          identifier: "CAI-9",
          trashed: true,
        },
        foundIssue,
      ],
    },
  });
  const issue = await linear.findIssue({
    project: "04889d3e87bb",
    titlePrefix: "S3: salim-dev — ",
  });
  expect(issue?.identifier).toBe("CAI-450");
});

test("findIssue returns null when every match is trashed", async () => {
  respond({ projects: { nodes: [projectQuery] } });
  respond({ issues: { nodes: [{ ...foundIssue, trashed: true }] } });
  await expect(
    linear.findIssue({
      project: "04889d3e87bb",
      titlePrefix: "S3: salim-dev — ",
    }),
  ).resolves.toBeNull();
});

test("findIssue returns the first non-trashed node, which Linear orders newest first", async () => {
  respond({ projects: { nodes: [projectQuery] } });
  respond({
    issues: {
      nodes: [
        {
          ...foundIssue,
          id: "newest-uuid",
          identifier: "CAI-451",
          description: null,
        },
        { ...foundIssue, id: "older-uuid", identifier: "CAI-450" },
      ],
    },
  });
  const issue = await linear.findIssue({
    project: "04889d3e87bb",
    titlePrefix: "S3: salim-dev — ",
  });
  expect(issue?.identifier).toBe("CAI-451");
  expect(issue?.description).toBe("");
});

test("GraphQL errors throw", async () => {
  replies.push(
    jsonResponse({ errors: [{ message: "boom", extensions: { code: "INVALID_INPUT" } }] }),
  );
  const error = await linear.getIssueParticipants("x").catch((err: unknown) => err);
  expect(error).toBeInstanceOf(ProviderApiError);
  expect(error).toMatchObject({ provider: "linear", status: 200, code: "INVALID_INPUT" });
  expect(String(error)).toContain("Linear API 200 on IssueParticipants: boom");
});

test("a reply that is not JSON, or carries no data, fails naming the call", async () => {
  replies.push(new Response("<html>bad gateway</html>"));
  await expect(linear.resolveIssueRef("AGE-1")).rejects.toThrow(
    "Linear API 200 on IssueRef: response was not JSON",
  );
  replies.push(jsonResponse({}));
  await expect(linear.resolveIssueRef("AGE-1")).rejects.toThrow(
    "Linear API 200 on IssueRef: response carried no data",
  );
  replies.push(new Response("upstream down", { status: 503 }));
  await expect(linear.resolveIssueRef("AGE-1")).rejects.toThrow(
    "Linear API 503 on IssueRef: upstream down",
  );
});
