import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  createComment,
  createIssueInProject,
  fetchIssueSnapshot,
  fetchIssueStates,
  findComment,
  findIssueInProject,
  getIssueParticipants,
  listCommentsSince,
  listWebhooks,
  mention,
  resolveIssueRef,
  updateIssueState,
} from "./linear.ts";

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("LINEAR_API_KEY", "lin_test_key");
  vi.stubEnv("LINEAR_API_URL", "http://mock.test/graphql");
  fetchMock.mockReset();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const respond = (data: unknown) =>
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ data }), { status: 200 }));

const requestBodies = () =>
  fetchMock.mock.calls.map(([, init]) => JSON.parse((init as RequestInit).body as string));

const lastRequest = () => {
  const [url, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
  return { url, init, body: JSON.parse(init.body as string) };
};

test("requests carry the API key and hit the override URL", async () => {
  respond({ issue: { creator: { id: "u1", name: "salim" } } });
  await getIssueParticipants("68bc9696-35d5-442d-ab56-214c8cfefbec");
  const { url, init } = lastRequest();
  expect(url).toBe("http://mock.test/graphql");
  expect(new Headers(init.headers).get("authorization")).toBe("lin_test_key");
});

test("listWebhooks traverses every page", async () => {
  respond({
    webhooks: {
      nodes: [{ url: "https://first.test/hook", enabled: true }],
      pageInfo: { hasNextPage: true, endCursor: "page-2" },
    },
  });
  respond({
    webhooks: {
      nodes: [
        { url: "https://old.test/ingress/linear", enabled: true },
        { url: "https://factory.test/ingress/linear", enabled: false },
      ],
      pageInfo: { hasNextPage: false, endCursor: "page-2" },
    },
  });

  await expect(listWebhooks()).resolves.toEqual([
    { url: "https://first.test/hook", enabled: true },
    { url: "https://old.test/ingress/linear", enabled: true },
    { url: "https://factory.test/ingress/linear", enabled: false },
  ]);
  expect(requestBodies().map((body) => body.variables)).toEqual([
    { after: null },
    { after: "page-2" },
  ]);
});

test("fetchIssueSnapshot asks for the snapshot fields in one round trip", async () => {
  respond({ issue: { id: "i1", identifier: "AGE-313" } });
  const issue = await fetchIssueSnapshot("issue-uuid");
  expect(issue.identifier).toBe("AGE-313");
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const { url, body } = lastRequest();
  expect(url).toBe("http://mock.test/graphql");
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
  await expect(fetchIssueStates("issue-uuid")).resolves.toMatchObject({
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
  await expect(updateIssueState("issue-uuid", "done")).resolves.toBeUndefined();
  const request = lastRequest().body;
  expect(request.query).toContain("issueUpdate");
  expect(request.variables).toEqual({ issueId: "issue-uuid", stateId: "done" });
});

test("resolveIssueRef normalizes either accepted Linear reference", async () => {
  respond({ issue: { id: "issue-uuid", identifier: "AGE-346" } });
  await expect(resolveIssueRef("AGE-346")).resolves.toEqual({
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
  const body = `${mention({ id: "u1", name: "salim" })} this run needs a human.`;
  const comment = await createComment("issue-uuid", body);
  expect(comment).toEqual({ id: "c1", createdAt: "2026-08-26T12:00:00Z" });
  const request = lastRequest().body;
  expect(request.query).toContain("commentCreate");
  expect(request.variables.input).toEqual({ issueId: "issue-uuid", body });
  expect(request.variables.input.body).toContain("@[salim](u1)");
});

test("createComment names the comment when given an id", async () => {
  respond({ commentCreate: { success: true, comment: { id: "c-id", createdAt: "t" } } });
  await createComment("issue-uuid", "hi", "c-id");
  expect(lastRequest().body.variables.input).toEqual({
    issueId: "issue-uuid",
    body: "hi",
    id: "c-id",
  });
});

test("findComment returns the comment by id, or null when there is none", async () => {
  respond({ comments: { nodes: [{ id: "c-id", createdAt: "t" }] } });
  await expect(findComment("c-id")).resolves.toEqual({ id: "c-id", createdAt: "t" });
  expect(lastRequest().body.variables).toEqual({ id: "c-id" });
  respond({ comments: { nodes: [] } });
  await expect(findComment("c-id")).resolves.toBeNull();
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

test("createIssueInProject resolves a slugId then creates in its first team", async () => {
  respond({ projects: { nodes: [projectQuery] } });
  respond({ issueCreate: { success: true, issue: createdIssue } });
  await expect(
    createIssueInProject({
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

test("createIssueInProject looks a UUID up as the project id", async () => {
  respond({ project: projectQuery });
  respond({ issueCreate: { success: true, issue: createdIssue } });
  await createIssueInProject({
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

test("createIssueInProject throws naming the unresolvable project", async () => {
  respond({ projects: { nodes: [] } });
  await expect(
    createIssueInProject({ project: "nope", title: "t", description: "d" }),
  ).rejects.toThrow("Linear project not found: nope");
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test("createIssueInProject throws when the project carries no team", async () => {
  respond({
    projects: { nodes: [{ id: "project-uuid", teams: { nodes: [] } }] },
  });
  await expect(
    createIssueInProject({
      project: "04889d3e87bb",
      title: "t",
      description: "d",
    }),
  ).rejects.toThrow("Linear project has no team: 04889d3e87bb");
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test("createIssueInProject throws when issueCreate reports failure", async () => {
  respond({ projects: { nodes: [projectQuery] } });
  respond({ issueCreate: { success: false, issue: null } });
  await expect(
    createIssueInProject({
      project: "04889d3e87bb",
      title: "t",
      description: "d",
    }),
  ).rejects.toThrow("Linear issueCreate failed for project 04889d3e87bb");
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

test("findIssueInProject filters by project and title prefix", async () => {
  respond({ projects: { nodes: [projectQuery] } });
  respond({ issues: { nodes: [foundIssue] } });
  await expect(
    findIssueInProject({
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
  expect(find.query).toContain("title: { startsWith: $prefix }");
  expect(find.query).toContain("orderBy: createdAt");
  expect(find.variables).toEqual({
    projectId: "project-uuid",
    prefix: "S3: salim-dev — ",
  });
});

test("findIssueInProject returns null when nothing matches", async () => {
  respond({ projects: { nodes: [projectQuery] } });
  respond({ issues: { nodes: [] } });
  await expect(
    findIssueInProject({ project: "04889d3e87bb", titlePrefix: "S3: gone — " }),
  ).resolves.toBeNull();
});

test("findIssueInProject skips trashed matches", async () => {
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
  const issue = await findIssueInProject({
    project: "04889d3e87bb",
    titlePrefix: "S3: salim-dev — ",
  });
  expect(issue?.identifier).toBe("CAI-450");
});

test("findIssueInProject returns null when every match is trashed", async () => {
  respond({ projects: { nodes: [projectQuery] } });
  respond({ issues: { nodes: [{ ...foundIssue, trashed: true }] } });
  await expect(
    findIssueInProject({
      project: "04889d3e87bb",
      titlePrefix: "S3: salim-dev — ",
    }),
  ).resolves.toBeNull();
});

test("findIssueInProject returns the first non-trashed node, which Linear orders newest first", async () => {
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
  const issue = await findIssueInProject({
    project: "04889d3e87bb",
    titlePrefix: "S3: salim-dev — ",
  });
  expect(issue?.identifier).toBe("CAI-451");
  expect(issue?.description).toBe("");
});

test("listCommentsSince filters strictly after the cursor", async () => {
  respond({
    issue: {
      comments: {
        nodes: [
          {
            id: "c1",
            body: "old",
            createdAt: "2026-08-26T10:00:00Z",
            user: { id: "u1", name: "salim" },
          },
          {
            id: "c2",
            body: "new",
            createdAt: "2026-08-26T12:00:01Z",
            user: { id: "u1", name: "salim" },
          },
        ],
      },
    },
  });
  const comments = await listCommentsSince("issue-uuid", "2026-08-26T12:00:00Z");
  expect(comments.map((c) => c.id)).toEqual(["c2"]);
});

test("GraphQL errors and missing keys throw", async () => {
  fetchMock.mockResolvedValueOnce(
    new Response(JSON.stringify({ errors: [{ message: "boom" }] }), {
      status: 200,
    }),
  );
  await expect(getIssueParticipants("x")).rejects.toThrow("boom");

  vi.stubEnv("LINEAR_API_KEY", "");
  await expect(getIssueParticipants("x")).rejects.toThrow("LINEAR_API_KEY");
});
